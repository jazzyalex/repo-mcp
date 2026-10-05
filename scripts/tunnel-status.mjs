import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';

export function summarizeStatus(data) {
  const errors = [data.error, data.remote_error].filter(Boolean).map(String).join(' ');
  const auth = /401|invalid_api_key|expired|revoked/i.test(errors);
  const permissions = /403|permission|forbidden/i.test(errors);
  if (auth) return {ok:false, state:'credential_rejected', message:'OpenAI rejected the saved runtime key. It may be expired or revoked. Rotate it explicitly with connect.sh --rotate-key; restarting will not renew it.'};
  if (permissions) return {ok:false, state:'access_denied', message:'Verify the runtime key principal has Tunnels Read + Use in the tunnel organization.'};
  if (errors) return {ok:false, state:'tunnel_error', message:'Tunnel lookup reported an error. Local healthy/ready flags do not establish remote connectivity.'};
  if (data.process_running !== true || data.healthy !== true || data.ready !== true) return {ok:false, state:'not_ready', message:'Tunnel process is stopped or not ready. Start the local MCP server, then reconnect the saved tunnel profile.'};
  if (!data.live_poll && (data.remote_lookup_attempted !== true || data.remote_skipped_reason)) return {ok:false, state:'remote_unverified', message:'Local tunnel is ready, but remote access was not verified. Confirm with a ChatGPT repo_info call.'};
  const poll = data.live_poll;
  const lastSuccess = Date.parse(poll?.details?.last_success ?? '');
  const age = Date.now() - lastSuccess;
  if (poll?.status !== 'ok' || poll?.details?.consecutive_failures !== 0 || !Number.isFinite(age) || age < -5000 || age > 90000) return {ok:false, state:'poll_unverified', message:'Local runtime and credentials are available, but no recent successful control-plane poll was verified. Do not assume ChatGPT is connected.'};
  return {ok:true, state:'ready', message:'A recent successful OpenAI control-plane poll is verified. Confirm the ChatGPT route with repo_info.'};
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let summary;
  try {
    let data;
    if (process.argv[2] === '--health-file') {
      const url = new URL('/health?details=true', readFileSync(process.argv[3], 'utf8').trim());
      if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') throw new Error('Unexpected health address');
      const response = await fetch(url, {signal:AbortSignal.timeout(2000)});
      const health = await response.json();
      data = {health_url:url.href, process_running:health.live, healthy:health.live, ready:health.ready, live_poll:health.components?.['control-plane']};
    } else data = JSON.parse(readFileSync(process.argv[2] ?? 0,'utf8'));
    summary = summarizeStatus(data);
    if (summary.state === 'poll_unverified' && data.health_url) {
      const url = new URL('/health?details=true', data.health_url);
      if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') throw new Error('Unexpected health address');
      const deadline = Date.now() + 40000;
      do {
        try {
          const response = await fetch(url, {signal:AbortSignal.timeout(2000)});
          const health = await response.json();
          data = {...data, process_running:health.live, healthy:health.live, ready:health.ready, live_poll:health.components?.['control-plane']};
          summary = summarizeStatus(data);
          if (summary.state !== 'poll_unverified' || (data.live_poll?.details?.consecutive_failures ?? 0) > 0) break;
        } catch { /* Missing live health remains an explicit failure. */ }
        if (Date.now() >= deadline) break;
        await new Promise(resolve => setTimeout(resolve, 1000));
      } while (Date.now() < deadline);
    }
  }
  catch {summary={ok:false,state:'unreadable_status',message:'Tunnel status could not be read. Check that tunnel-client is installed and configured.'};}
  // Never print the raw result: upstream diagnostics can contain credentials.
  console.log(JSON.stringify(summary,null,2));
  process.exitCode=summary.ok ? 0 : 1;
}
