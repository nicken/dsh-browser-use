/**
 * 测试脚手架：用假的 Cordis 上下文挂载插件，不启动 DSH host。
 *
 * 真实的 DSH 会在 connection seam 就绪后调用 inject 回调、在 effects 生命周期里
 * 注册工具；这里用最小替身复刻同样的形状，让 index.js 的 apply() 原样跑起来。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const SESSION = 'test-session';

export async function createHarness({
  browserUse = true,
  advanced = false,
  policy = null,
  approvalOutcome = 'allowed-once',
  approvalPolicy = 'standard',
} = {}) {
  // 每个测试用独立的 DSH_HOME，避免污染真实配置
  const dshHome = mkdtempSync(join(tmpdir(), 'dsh-browser-use-test-'));
  process.env.DSH_HOME = dshHome;
  mkdirSync(join(dshHome, 'browser-use'), { recursive: true });
  writeFileSync(
    join(dshHome, 'capability-toggles.json'),
    JSON.stringify({ version: 1, sessions: { [SESSION]: { browserUse, browserUseAdvanced: advanced } } }),
  );
  if (policy) writeFileSync(join(dshHome, 'browser-use', 'policy.json'), JSON.stringify(policy));

  const tools = new Map(); // name -> { def, when }
  const routes = [];
  const disposers = [];
  const approval = {
    request: async () => approvalOutcome,
    effectivePolicy: () => approvalPolicy,
  };

  const register = (dispose) => {
    if (typeof dispose === 'function') disposers.push(dispose);
    return () => {};
  };

  const ctx = {
    tools: {
      register(def, options = {}) {
        tools.set(def.name, { def, when: options?.when });
        return () => tools.delete(def.name);
      },
    },
    effect(fn) {
      const dispose = fn();
      return register(dispose);
    },
    inject(_deps, callback) {
      callback({
        connection: {
          fetch: {
            register(route) {
              routes.push(route);
              return () => {};
            },
          },
        },
        effect: (fn) => register(fn()),
      });
    },
    get(seam) {
      return seam === 'approval' ? approval : undefined;
    },
  };

  const { apply } = await import('../index.js');
  apply(ctx);

  const exec = { agent: { session: { id: SESSION } }, callId: 'call-1', signal: undefined };

  return {
    dshHome,
    tools,
    routes,
    exec,
    /** 当前会话可见的工具名（模拟 host 对 when 谓词的求值） */
    visibleTools(agent = exec.agent) {
      return [...tools.entries()]
        .filter(([, entry]) => typeof entry.when !== 'function' || entry.when({ agent }))
        .map(([name]) => name)
        .sort();
    },
    /** 调用已注册的工具，等价于 host 的 tool.execute（不可见的工具会被拒绝） */
    call(name, args = {}) {
      const entry = tools.get(name);
      if (!entry) throw new Error(`tool ${name} is not registered`);
      if (typeof entry.when === 'function' && !entry.when({ agent: exec.agent })) {
        throw new Error(`tool ${name} is not visible for this session`);
      }
      return entry.def.execute(args, exec);
    },
    cleanup() {
      for (const dispose of disposers.reverse()) {
        try {
          dispose();
        } catch {
          /* ignore */
        }
      }
      disposers.length = 0;
      rmSync(dshHome, { recursive: true, force: true });
    },
  };
}
