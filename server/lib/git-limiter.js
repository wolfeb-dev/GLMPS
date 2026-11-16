// server/lib/git-limiter.js
// One process-wide cap on concurrent `git` child processes. Both scanRepos /
// sweepSessionWorktrees (server.js) and the surface routes' repoTree/fileDiff
// (lib/surface/repo-tree.js) fan out with Promise.all (repos x branches, or
// 4 git calls per tree/diff request) for wall-clock speed, which without a
// cap could spawn hundreds of concurrent subprocesses on a workstation with
// many repos/branches -- real process-creation + AV-scan overhead per spawn
// on Windows then makes the *concurrent* version slower (or, under parallel
// test-file load, starves the whole machine) than the sequential one it
// replaced. Every git-invoking module shares this ONE instance below rather
// than creating its own pool, so the cap is process-wide, not per-caller.
export function createLimiter(max) {
  let active = 0;
  const queue = [];
  return function run(fn) {
    return new Promise((resolve, reject) => {
      const attempt = () => {
        active++;
        fn().then(resolve, reject).finally(() => {
          active--;
          const next = queue.shift();
          if (next) next();
        });
      };
      if (active < max) attempt(); else queue.push(attempt);
    });
  };
}

export const gitLimiter = createLimiter(3);
