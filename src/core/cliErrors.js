'use strict';

/**
 * Turn Sitecore CLI output from a failed run into one plain-language next step.
 * stage: 'pull' (cloud), 'snapshot' | 'push' | 'cleanup' (local)
 */
function explainCliFailure(lines, stage) {
  const text = lines.join('\n');
  const local = stage !== 'pull';
  if (/actively refused|ECONNREFUSED|No connection could be made|No such host|Name or service not known|ENOTFOUND|connection was closed|timed out/i.test(text)) {
    return local
      ? 'The local CM is not reachable. Start your containers (up.ps1) and check that https://xmcloudcm.localhost/sitecore opens, then sync again.'
      : 'The cloud environment is not reachable. Check your internet connection or VPN.';
  }
  if (/\b401\b|Unauthorized|invalid_grant|refresh token|not logged in|log in again|login/i.test(text)) {
    return 'Your Sitecore login has expired. Run "dotnet sitecore cloud login" in the project folder, then sync again.';
  }
  if (/\b403\b|Forbidden|access denied/i.test(text)) return 'Access denied. Your account has no access to this environment.';
  if (/not configured to allow writing/i.test(text)) return 'The Sitecore CLI refused the endpoint because allowWrite is off. Update DevSync to the latest version.';
  if (/Could not execute because the specified command or file was not found|dotnet-sitecore|No executable found|tool.*not.*installed/i.test(text)) {
    return 'The Sitecore CLI is not installed for this project. Run "dotnet tool restore" in the project folder.';
  }
  if (/Filesystem integrity validation found errors/i.test(text)) return 'Some prepared item files failed SCS validation and could not be repaired automatically. The Log tab lists the files; sync again, and if it repeats, share the log with your team.';
  if (/parent item .* does not exist|parent .* not found/i.test(text)) return 'A parent item is missing locally. Select the parent item too, then sync again.';
  if (/item .* (was )?not found|does not exist in the database/i.test(text) && stage === 'pull') {
    return 'A selected item no longer exists in the cloud. Remove it from the selection and sync again.';
  }
  return '';
}

/**
 * The few output lines that say what actually went wrong, for the report (the generic
 * "exited with code 1" says nothing). Timestamps and noise are stripped; at most `max` lines.
 */
function keyErrorLines(lines, max = 3) {
  const out = [];
  for (let l of lines) {
    l = String(l).replace(/^\s*\d{1,2}:\d{2}(:\d{2})?\s*(AM|PM)?\s*/i, '').trim();
    if (!l || /exited with code|already equal to the value to set|extraneous commands/i.test(l)) continue;
    if (!/error|exception|failed|cannot|can't|could not|refused|invalid|incorrect|not found|did not exist|denied|unauthori[sz]ed/i.test(l)) continue;
    l = l.replace(/^GraphQL\.ExecutionError:\s*/i, '').replace(/\[Inner Exception\]\s*/i, '');
    if (!out.includes(l)) out.push(l.length > 400 ? l.slice(0, 400) + '…' : l);
  }
  return out.slice(-max);
}

module.exports = { explainCliFailure, keyErrorLines };
