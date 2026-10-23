import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RelayCdp } from './cdp-relay.js';
import { GoError, type ChatGptPage, type TurnState } from './chatgpt-go.js';

// ChatGPT web page driver over raw Chrome DevTools Protocol (docs/GO-DRIVER-SPEC.md §6).
// It drives the owner's main, signed-in Chrome through the local CDP relay
// (src/cdp-relay.ts), so Chrome asks for remote-debugging approval once per Chrome start.
// Every element lookup must match exactly one visible element: zero is UI_MISSING,
// several is UI_AMBIGUOUS. There is no "first plausible match" fallback.

const ORIGIN = 'https://chatgpt.com';
const EFFORTS = ['Light', 'Medium', 'High', 'Extra High', 'Pro'];

/** Page-side selector table. Each entry is a CSS selector plus an optional exact/prefix text filter. */
const SELECTORS: Record<string, { css: string; text?: string; prefix?: string; contains?: string }> = {
  composer: { css: '#prompt-textarea,.ProseMirror[contenteditable="true"]' },
  plus: { css: 'form button[aria-label="Add files and more"],[data-testid="composer-plus-btn"]' },
  repoMcpItem: { css: 'button,[role="menuitem"]', prefix: 'Repo MCP', contains: 'local Git repository' },
  effortButton: { css: 'form button[aria-label="Select ChatGPT model"]', text: '__EFFORT__' },
  slider: { css: '[role="slider"]' },
  send: { css: 'form button[aria-label="Send"],[data-testid="send-button"]' },
  stop: { css: 'button[aria-label="Stop"],[data-testid="stop-button"]' },
  more: { css: 'header button[aria-label="More"],[data-testid="conversation-options-button"]' },
  archiveItem: { css: '[role="menuitem"],button', text: 'Archive' }
};

/** Runs in the page. Returns visible matches of a selector-table entry with their click points. */
const PAGE_HELPERS = String.raw`
(() => {
  const S = ${JSON.stringify(SELECTORS)};
  const EFFORTS = ${JSON.stringify(EFFORTS)};
  const visible = e => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  // innerText is empty for content the browser skipped rendering (a long menu's lower
  // items), so fall back to textContent before the accessible label.
  const text = e => (e.innerText || e.textContent || e.getAttribute('aria-label') || '').trim();
  const norm = t => t.replace(/\s+/g, ' ').trim();
  // The model button may carry a caption line above the effort ("Thinking effort" then
  // "Extra High"): the effort is its last non-empty line.
  const effort = e => text(e).split('\n').map(l => l.trim()).filter(Boolean).at(-1) ?? '';
  window.__go = {
    find(name) {
      const spec = S[name];
      return [...document.querySelectorAll(spec.css)].filter(visible).filter(e =>
        spec.text === '__EFFORT__' ? EFFORTS.includes(effort(e)) :
        spec.text !== undefined ? text(e) === spec.text :
        spec.prefix !== undefined ? text(e).startsWith(spec.prefix) && (!spec.contains || text(e).includes(spec.contains)) : true)
        .map(e => { const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, text: spec.text === '__EFFORT__' ? effort(e) : text(e), disabled: !!e.disabled || e.getAttribute('aria-disabled') === 'true' }; });
    },
    chip() { return [...document.querySelectorAll('button,span,div')].filter(e => e.childElementCount === 0 && visible(e) && e.innerText?.trim() === 'Repo MCP').length; },
    composerText() { const c = [...document.querySelectorAll(S.composer.css)].filter(visible); return c.length === 1 ? norm(c[0].innerText || '') : null; },
    signedIn() { return { composer: this.find('composer').length, login: [...document.querySelectorAll('button,a')].some(b => visible(b) && /^log in$/i.test((b.innerText || '').trim())) }; },
    // Hidden/inert fallback copies ("ChatGPT said:") are not messages.
    messages(role) { return [...document.querySelectorAll('[data-message-author-role="' + role + '"],[data-content-search-unit-key$=":' + role + '"]')]
      .filter(e => !e.closest('[hidden],[inert]') && visible(e)); },
    answerText(e) { return (e?.innerText || '').replace(/^\s*ChatGPT said:\s*/, '').trim(); },
    turnState() { return [...document.querySelectorAll('[data-talvt-turn-state]')].at(-1)?.getAttribute('data-talvt-turn-state') ?? null; },
    turnOrder(promptHead) {
      const users = this.messages('user'); const last = users.at(-1);
      if (!last || !norm(last.innerText || '').includes(promptHead)) return { user: false, answer: '' };
      const answers = this.messages('assistant').filter(a => last.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING);
      return { user: true, answer: this.answerText(answers.at(-1)), userLength: norm(last.innerText || '').length, turn: this.turnState() };
    },
    sliderLabel() {
      const s = document.querySelector('[role="slider"]');
      const v = s?.getAttribute('aria-valuetext');
      if (v && EFFORTS.includes(v.trim())) return v.trim();
      const pop = s?.closest('[role="dialog"],[data-radix-popper-content-wrapper],[role="menu"]') || document;
      const hits = [...pop.querySelectorAll('*')].filter(e => e.childElementCount === 0 && visible(e) && EFFORTS.includes(e.innerText?.trim()));
      return hits.length === 1 ? hits[0].innerText.trim() : null;
    }
  };
  return true;
})()`;

const normalize = (t: string) => t.replace(/\s+/g, ' ').trim();

type TargetInfo = { targetId: string; type: string; url: string };

export class CdpChatGptPage implements ChatGptPage {
  private cdp?: RelayCdp;
  private session?: string;
  private targetId?: string;
  private reloaded = false;
  constructor(private sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))) {}

  private async browser() {
    if (!this.cdp) this.cdp = await RelayCdp.connect();
    return this.cdp;
  }

  private send(method: string, params: Record<string, unknown> = {}) {
    if (!this.cdp || !this.session) throw new GoError('BROWSER_UNAVAILABLE', 'No page attached.');
    return this.cdp.send(method, params, this.session);
  }

  private async attachTo(targetId: string) {
    const cdp = await this.browser();
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    this.session = sessionId;
    this.targetId = targetId;
    await this.send('Page.enable');
    await this.send('Runtime.enable');
    await cdp.send('Target.activateTarget', { targetId }).catch(() => {});
  }

  private async newTab(url: string) {
    const cdp = await this.browser();
    const { targetId } = await cdp.send('Target.createTarget', { url, newWindow: true });
    await this.attachTo(targetId);
    return targetId as string;
  }

  private async eval<T>(expression: string): Promise<T> {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) {
      const d = result.exceptionDetails;
      throw new GoError('PAGE_SCRIPT_ERROR', `${d.text ?? 'Page script failed'}: ${d.exception?.description?.split('\n')[0] ?? ''}`);
    }
    return result.result?.value as T;
  }

  private async helpers() { await this.eval(PAGE_HELPERS); }

  private async one(name: string) {
    await this.helpers();
    const hits = await this.eval<{ x: number; y: number; text: string; disabled: boolean }[]>(`window.__go.find(${JSON.stringify(name)})`);
    if (hits.length === 0) throw new GoError(`UI_MISSING:${name}`, `ChatGPT control ${name} not found.`);
    if (hits.length > 1) throw new GoError(`UI_AMBIGUOUS:${name}`, `ChatGPT control ${name} matched ${hits.length} elements.`);
    return hits[0];
  }

  private async waitFor(name: string, timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      try { return await this.one(name); }
      catch (error) {
        if (!(error instanceof GoError) || !error.code.startsWith('UI_MISSING') || Date.now() > deadline) throw error;
        await this.sleep(300);
      }
    }
  }

  private async click(point: { x: number; y: number }) {
    const base = { x: point.x, y: point.y, button: 'left', clickCount: 1 };
    await this.send('Input.dispatchMouseEvent', { ...base, type: 'mouseMoved' });
    await this.send('Input.dispatchMouseEvent', { ...base, type: 'mousePressed' });
    await this.send('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased' });
  }

  private async key(key: string, code = key, keyCode?: number) {
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: keyCode });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode });
  }

  private async assertSignedIn() {
    const deadline = Date.now() + 20_000;
    while (true) {
      // The page may still be navigating: a reload between installing the helpers and
      // using them is retried until the deadline, never reported as a script error.
      let state: { composer: number; login: boolean; challenge: boolean };
      try {
        await this.helpers();
        state = { ...await this.eval<{ composer: number; login: boolean }>('window.__go.signedIn()'),
          challenge: await this.eval<string>('document.title') === 'Just a moment...' };
      } catch (error) {
        if (!(error instanceof GoError && error.code === 'PAGE_SCRIPT_ERROR') || Date.now() > deadline) throw error;
        await this.sleep(500);
        continue;
      }
      if (state.composer === 1 && !state.login) return;
      if (Date.now() > deadline) {
        if (state.challenge) throw new GoError('BROWSER_CHALLENGE', 'ChatGPT shows a browser check; stop and let the owner resolve it.');
        throw new GoError('CHATGPT_SIGNED_OUT', 'Chrome is not signed in to ChatGPT, or the composer was not found.');
      }
      await this.sleep(500);
    }
  }

  async open() {
    const targetId = await this.newTab(`${ORIGIN}/`);
    await this.assertSignedIn();
    await this.sleep(1_500); // let the restored draft and composer finish hydrating
    await this.clearComposer();
    return { targetId };
  }

  /** ChatGPT restores unsent drafts into new chats; start every run from an empty composer. */
  private async clearComposer() {
    for (let attempt = 0; attempt < 3; attempt++) {
      await this.helpers();
      if (await this.eval<string | null>('window.__go.composerText()') === '' && await this.eval<number>('window.__go.chip()') === 0) return;
      await this.click(await this.waitFor('composer'));
      // Select the editor's whole content, then delete it as a user edit ProseMirror understands.
      await this.eval(`(() => { const c = [...document.querySelectorAll(${JSON.stringify(SELECTORS.composer.css)})].find(e => e.getBoundingClientRect().width > 0);
        if (!c) return false; c.focus(); const r = document.createRange(); r.selectNodeContents(c); const s = getSelection(); s.removeAllRanges(); s.addRange(r); return true; })()`);
      await this.sleep(100);
      await this.key('Backspace', 'Backspace', 8);
      await this.sleep(300);
    }
    throw new GoError('COMPOSER_NOT_EMPTY', 'Could not clear a restored draft from the composer.');
  }

  /** Save a JPEG of the page for diagnosis under the relay folder; failures are ignored. */
  async screenshot(name: string) {
    try {
      const shot = await this.send('Page.captureScreenshot', { format: 'jpeg', quality: 50 });
      const dir = path.join(os.homedir(), 'Library', 'Application Support', 'repo-mcp', 'relay', 'shots');
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await writeFile(path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${name}.jpg`), Buffer.from(shot.data, 'base64'), { mode: 0o600 });
    } catch { /* diagnosis only */ }
  }

  currentTargetId() { return this.targetId; }

  /** The verified Cloudflare check page; never a scan of page or conversation text. */
  async accountSignal() {
    if (!this.session) return null;
    return await this.eval<string>('document.title').catch(() => '') === 'Just a moment...' ? 'BROWSER_CHALLENGE' : null;
  }

  async closeTab() {
    if (!this.cdp || !this.targetId) return;
    await this.cdp.send('Target.closeTarget', { targetId: this.targetId }).catch(() => {});
    this.session = undefined;
  }

  async reattach(targetId: string | undefined, conversationUrl: string | undefined) {
    const cdp = await this.browser();
    const { targetInfos } = await cdp.send('Target.getTargets') as { targetInfos: TargetInfo[] };
    const existing = targetInfos.find(t => t.targetId === targetId && t.type === 'page' && t.url.startsWith(ORIGIN));
    if (existing && (!conversationUrl || existing.url.startsWith(conversationUrl))) {
      await this.attachTo(existing.targetId);
      return true;
    }
    if (!conversationUrl || !conversationUrl.startsWith(`${ORIGIN}/c/`)) return false;
    await this.newTab(conversationUrl);
    await this.assertSignedIn().catch(() => {});
    await this.sleep(3_000);
    return (await this.eval<string>('location.href')).startsWith(conversationUrl);
  }

  async attachRepoMcp() {
    await this.helpers();
    if (await this.eval<number>('window.__go.chip()') === 1) return;
    let item: { x: number; y: number } | undefined;
    // A freshly loaded page can show the "+" tooltip before its click handler is live,
    // so the menu may not open on the first click; give hydration time and retry.
    for (let attempt = 0; attempt < 3 && !item; attempt++) {
      await this.sleep(attempt === 0 ? 1_000 : 2_500);
      await this.click(await this.waitFor('plus'));
      try { item = await this.waitFor('repoMcpItem', 6_000); }
      catch (error) {
        await this.screenshot(`repo-mcp-item-${attempt}`);
        if (attempt === 2) throw error;
        await this.key('Escape');
      }
    }
    await this.click(item!);
    await this.sleep(500);
    await this.key('Escape');
    await this.helpers();
    const chips = await this.eval<number>('window.__go.chip()');
    if (chips !== 1) throw new GoError(chips === 0 ? 'UI_MISSING:repo-mcp-chip' : 'UI_AMBIGUOUS:repo-mcp-chip', 'Repo MCP is not attached exactly once.');
  }

  async pastePrompt(prompt: string) {
    await this.click(await this.waitFor('composer'));
    await this.key('End');
    await this.send('Input.insertText', { text: prompt });
    await this.sleep(500);
    await this.helpers();
    const composer = await this.eval<string | null>('window.__go.composerText()');
    if (composer === null) throw new GoError('UI_AMBIGUOUS:composer', 'Composer is not unique.');
    // The Repo MCP mention may render as text inside the composer; the prompt must follow it exactly.
    if (!composer.endsWith(normalize(prompt)) || composer.length > normalize(prompt).length + 40) {
      throw new GoError('COMPOSER_MISMATCH', 'The composer text does not equal the prompt.');
    }
  }

  async selectEffort(label: string) {
    if (!EFFORTS.includes(label)) throw new GoError('UNKNOWN_EFFORT', `Unknown effort ${label}.`);
    await this.click(await this.waitFor('effortButton'));
    const slider = await this.waitFor('slider', 5_000);
    await this.click(slider);
    let selectedAt = new Date();
    for (let step = 0; step < EFFORTS.length + 1; step++) {
      await this.helpers();
      const current = await this.eval<string | null>('window.__go.sliderLabel()');
      if (current === null) throw new GoError('UI_MISSING:effort-label', 'Cannot read the effort slider label.');
      if (current === label) break;
      const right = EFFORTS.indexOf(label) > EFFORTS.indexOf(current);
      await this.key(right ? 'ArrowRight' : 'ArrowLeft', right ? 'ArrowRight' : 'ArrowLeft', right ? 39 : 37);
      selectedAt = new Date();
      await this.sleep(300);
    }
    await this.key('Escape');
    await this.sleep(500);
    const observed = await this.one('effortButton');
    return { selectedAt, observedLabel: observed.text };
  }

  async clickSend(budgetMs = Infinity) {
    const deadline = Date.now() + budgetMs;
    const send = await this.one('send');
    if (send.disabled) throw new GoError('UI_DISABLED:send', 'Send is disabled.');
    const base = { x: send.x, y: send.y, button: 'left', clickCount: 1 };
    await this.send('Input.dispatchMouseEvent', { ...base, type: 'mouseMoved' });
    // The press is the first input that can send: never start it past the budget.
    if (Date.now() > deadline) throw new GoError('SEND_NOT_CLICKED', 'The click budget ran out before the press; nothing was pressed.');
    await this.send('Input.dispatchMouseEvent', { ...base, type: 'mousePressed' });
    await this.send('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased' });
  }

  async conversationUrl() {
    const href = await this.eval<string>('location.href');
    // Only a real conversation ID; the SPA briefly shows placeholders such as /c/local-chatgpt.
    return /^https:\/\/chatgpt\.com\/c\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.exec(href)?.[0];
  }

  private async order(prompt: string) {
    await this.helpers();
    const head = normalize(prompt).slice(0, 300);
    return this.eval<{ user: boolean; answer: string; userLength?: number; turn?: string | null }>(`window.__go.turnOrder(${JSON.stringify(head)})`);
  }

  async hasExpectedUserMessage(prompt: string) {
    const o = await this.order(prompt);
    // Long user messages render collapsed ("Show more"), so only the head is comparable.
    // The head starts with the per-request run marker, so a match is this run's message.
    if (o.user) return true;
    return (await this.orderAfterFullRender(prompt)).user;
  }

  /**
   * A conversation can render in a "fallback" mode that shows only the in-progress
   * assistant turn. When no user message is visible, reload once to render the full
   * thread; the running turn is unaffected.
   */
  private async orderAfterFullRender(prompt: string) {
    if (!this.reloaded && await this.eval<number>('window.__go.messages("user").length') === 0) {
      this.reloaded = true;
      await this.send('Page.reload');
      await this.sleep(6_000);
    }
    return this.order(prompt);
  }

  async turnState(prompt: string): Promise<TurnState> {
    let o = await this.order(prompt);
    if (!o.user) o = await this.orderAfterFullRender(prompt);
    if (!o.user) return { state: 'unknown', chars: 0 };
    const stop = await this.eval<number>('window.__go.find("stop").length');
    // Busy while a Stop control shows or the turn marker says it is not complete.
    if (stop > 0 || (o.turn != null && o.turn !== 'complete')) return { state: 'busy', chars: o.answer.length };
    if (o.turn !== 'complete') return { state: 'unknown', chars: o.answer.length };
    return o.answer ? { state: 'done', chars: o.answer.length } : { state: 'unknown', chars: 0 };
  }

  async readAnswer(prompt: string) {
    return (await this.order(prompt)).answer;
  }

  async archive() {
    const before = await this.conversationUrl();
    // Like the "+" menu, the "More" menu may not open on a click that lands before the
    // page is interactive; retry it a few times.
    let item: { x: number; y: number } | undefined;
    for (let attempt = 0; attempt < 3 && !item; attempt++) {
      await this.sleep(attempt === 0 ? 1_000 : 2_500);
      await this.click(await this.waitFor('more', 5_000));
      try { item = await this.waitFor('archiveItem', 5_000); }
      catch (error) {
        await this.screenshot(`archive-item-${attempt}`);
        if (attempt === 2) throw error;
        await this.key('Escape');
      }
    }
    await this.click(item!);
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if ((await this.conversationUrl()) !== before) return;
      await this.sleep(500);
    }
    throw new GoError('ARCHIVE_UNCONFIRMED', 'The conversation URL did not change after Archive.');
  }

  async close() {
    if (this.cdp && this.session) await this.cdp.send('Target.detachFromTarget', { sessionId: this.session }).catch(() => {});
    this.cdp?.close(); this.cdp = undefined; this.session = undefined;
  }

  /** Read-only selector check on the current compose page; never clicks Send. */
  async probe() {
    const report: Record<string, unknown> = {};
    try {
      const { targetId } = await this.open();
      report.target = targetId;
      await this.helpers();
      for (const name of ['composer', 'plus', 'effortButton', 'send', 'stop']) {
        report[name] = (await this.eval<unknown[]>(`window.__go.find(${JSON.stringify(name)})`)).length;
      }
      await this.attachRepoMcp();
      report.repoMcpChip = await this.eval<number>('window.__go.chip()');
      return report;
    } finally {
      // Close our tab and the relay socket, or the process would stay alive.
      await this.closeTab();
      await this.close();
    }
  }
}
