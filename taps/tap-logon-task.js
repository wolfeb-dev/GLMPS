// taps/tap-logon-task.js
// The tap agent's per-user logon scheduled task. Pure plan and apply with the
// schtasks calls injected, same shape as scripts/service/install-deploy-script.mjs.
// Nothing here registers a task by itself: the installer (build task 7) calls it.

export const LOGON_TASK_NAME = '\\GLMPS\\tap-agent';

const esc = (s) => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

// conhost --headless runs the console-subsystem node.exe with no window, so
// nothing flashes at sign-in.
export function logonTaskXml({ userId, nodePath, agentPath }) {
  for (const [k, v] of Object.entries({ userId, nodePath, agentPath })) if (!v) throw new TypeError(`${k} is required`);
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.3" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>GLMPS tap agent: heartbeat and local status for this user (card glmps-2-0-runtime-31)</Description>
    <URI>${esc(LOGON_TASK_NAME)}</URI>
  </RegistrationInfo>
  <Principals>
    <Principal id="Author">
      <UserId>${esc(userId)}</UserId>
      <LogonType>InteractiveToken</LogonType>
    </Principal>
  </Principals>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${esc(userId)}</UserId>
    </LogonTrigger>
  </Triggers>
  <Settings>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>999</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>conhost.exe</Command>
      <Arguments>${esc(`--headless "${nodePath}" "${agentPath}"`)}</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

/** What apply would do. queryTaskXml(name) -> {state:'present',xml} | {state:'absent'} | {state:'unknown',reason}. */
export function planLogonTask(args, { queryTaskXml }) {
  const xml = logonTaskXml(args);
  const task = queryTaskXml(LOGON_TASK_NAME);
  if (task.state === 'unknown') return { ok: false, reason: `could not read ${LOGON_TASK_NAME}: ${task.reason}` };
  if (task.state === 'absent') return { ok: true, todo: true, action: 'register', xml };
  // schtasks /Query /XML hands back the stored form, which can differ in whitespace.
  const norm = (s) => String(s).replace(/\s+/g, '');
  if (norm(task.xml) === norm(xml)) return { ok: true, todo: false, action: 'none', xml };
  return { ok: true, todo: true, action: 'update', xml, previousXml: task.xml };
}

export function applyLogonTask(plan, { createTask, log = console.log }) {
  if (!plan.ok) return { ok: false, reason: plan.reason };
  if (!plan.todo) { log(`[skip] ${LOGON_TASK_NAME} already matches`); return { ok: true }; }
  const r = createTask(plan.xml);
  if (!r.ok) { log(`[FAILED] ${plan.action} ${LOGON_TASK_NAME}: ${r.reason}`); return { ok: false, reason: r.reason }; }
  log(`[done] ${plan.action} ${LOGON_TASK_NAME}`);
  return { ok: true };
}
