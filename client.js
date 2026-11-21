/**
 * Browser control — Web client half of dsh-browser-use.
 *
 * Registers the 浏览器 Conversation tab (with its per-session on/off switch),
 * the composer browser status chip and one lightweight card per browser tool.
 * All capability state lives in the Host half (./index.js); this module only
 * renders and calls the authenticated /api/browser-use routes.
 */
window.__ModuleLoader__.load({
  id: 'dsh-browser-use',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Locale namespace owned by this plugin. */
    const NS = 'browserUse'
    /** Read/write route for the browser pool, pause state and audit trail. */
    const BU_STATUS_SUFFIX = 'api/browser-use/status'
    /** Read/write route for the per-session browser-control switch. */
    const BU_CAPABILITY_SUFFIX = 'api/browser-use/capability'

    const zh = {
      browserAct: '浏览器操作',
      browserAudit: '最近审计',
      browserAuditAll: '全部',
      browserAuditMine: '本会话',
      browserChip: '浏览器',
      browserClose: '关闭',
      browserCloseFailed: '关闭失败',
      browserConsole: '控制台',
      browserEvidence: '浏览器证据',
      browserInstances: '{n} 个浏览器',
      browserNetwork: '网络',
      browserNoAudit: '暂无审计记录',
      browserNoInstances: '当前没有打开的浏览器',
      browserObserve: '浏览器观察',
      browserOpen: '浏览器打开',
      browserPause: '暂停浏览器',
      browserPaused: '已暂停',
      browserPool: '浏览器池',
      browserRead: '浏览器读取',
      browserResume: '恢复浏览器',
      browserRunning: '运行中',
      browserSession: '浏览器会话',
      browserStatusOffline: '浏览器状态不可用',
      browserTabs: '标签页',
      browserThisSession: '本会话',
      browserView: '浏览器',
      cuRefused: '已拒绝',
      enlarge: '放大',
      loading: '正在加载…',
      noAuditMatch: '本会话暂无审计记录',
      running: '执行中…',
      shrink: '收起',
      browserCapabilityOff: '本会话未开启浏览器控制',
      browserCapabilityOn: '浏览器控制已开启',
      browserCapabilityEnable: '开启浏览器控制',
      browserCapabilityDisable: '关闭浏览器控制',
      browserCapabilityHint: '默认关闭；开启后浏览器工具在下一步生效。',
      browserCapabilityPending: '已保存，下一步生效',
      browserCapabilityFailed: '开关保存失败',
      browserCapabilityLoading: '正在读取开关状态…',
      browserCapabilitySwitch: '浏览器控制开关',
    }

    const en = {
      browserAct: 'Browser action',
      browserAudit: 'Recent audit',
      browserAuditAll: 'All',
      browserAuditMine: 'This session',
      browserChip: 'Browser',
      browserClose: 'Close',
      browserCloseFailed: 'Close failed',
      browserConsole: 'Console',
      browserEvidence: 'Browser evidence',
      browserInstances: '{n} browsers',
      browserNetwork: 'Network',
      browserNoAudit: 'No audit entries yet',
      browserNoInstances: 'No browser is open right now',
      browserObserve: 'Browser observe',
      browserOpen: 'Browser open',
      browserPause: 'Pause browsers',
      browserPaused: 'Paused',
      browserPool: 'Browser pool',
      browserRead: 'Browser read',
      browserResume: 'Resume browsers',
      browserRunning: 'Running',
      browserSession: 'Browser session',
      browserStatusOffline: 'Browser status unavailable',
      browserTabs: 'Tabs',
      browserThisSession: 'This session',
      browserView: 'Browser',
      cuRefused: 'Refused',
      enlarge: 'Enlarge',
      loading: 'Loading…',
      noAuditMatch: 'No audit entries for this session',
      running: 'Running…',
      shrink: 'Shrink',
      browserCapabilityOff: 'Browser control is off for this conversation',
      browserCapabilityOn: 'Browser control is on',
      browserCapabilityEnable: 'Turn browser control on',
      browserCapabilityDisable: 'Turn browser control off',
      browserCapabilityHint: 'Off by default; browser tools apply the change on the next step.',
      browserCapabilityPending: 'Saved — applies on the next step',
      browserCapabilityFailed: 'Could not save the switch',
      browserCapabilityLoading: 'Reading the switch state…',
      browserCapabilitySwitch: 'Browser control switch',
    }


    const CSS = `
.msm-page{box-sizing:border-box;height:100%;color:var(--dsw-alias-label-primary);flex-direction:column;align-items:center;gap:20px;padding:0 clamp(24px,4vw,48px) 48px;display:flex;overflow:auto}
.msm-page>*{width:100%;max-width:960px}
.msm-head{box-sizing:border-box;flex-wrap:wrap;justify-content:space-between;align-items:flex-start;gap:16px;padding-top:28px;display:flex}
.msm-heading{min-width:0;max-width:100%}
.msm-title{margin:0;font-size:20px;font-weight:500;line-height:28px}
.msm-subtitle{margin:4px 0 0;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}
.msm-head-actions{display:flex;align-items:center;gap:8px;flex:none}
.msm-row{display:flex;width:100%;max-width:960px;align-items:center}
.msm-tabs{display:inline-flex;gap:4px;padding:3px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}
.msm-tab{border:0;background:transparent;color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:13px;line-height:18px;padding:6px 12px;border-radius:8px;cursor:pointer;white-space:nowrap}
.msm-tab:hover{color:var(--dsw-alias-label-primary)}
.msm-tab[aria-selected="true"]{background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);box-shadow:inset 0 0 0 1px var(--dsw-alias-border-l1)}
.msm-tab:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.msm-stack{display:flex;flex-direction:column;gap:12px}
.msm-section-head{display:flex;align-items:flex-end;justify-content:space-between;gap:12px;flex-wrap:wrap}
.msm-section-title{margin:0;font-size:14px;font-weight:500;line-height:22px}
.msm-note{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.msm-counts{display:inline-flex;gap:10px;flex-wrap:wrap;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.msm-card{border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);padding:14px 16px;display:flex;flex-direction:column;gap:8px}
.msm-card[data-disabled="true"]{opacity:.72}
.msm-server-row{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap}
.msm-server-main{min-width:0;flex:1 1 320px;display:flex;flex-direction:column;gap:4px}
.msm-server-title-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.msm-server-name{font-size:14px;font-weight:600;line-height:20px}
.msm-chip{border:1px solid var(--dsw-alias-border-l1);border-radius:999px;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px;padding:0 6px;white-space:nowrap}
.msm-endpoint{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.msm-hint{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.msm-status{display:inline-flex;align-items:center;gap:6px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.msm-dot{width:8px;height:8px;border-radius:999px;flex:none;background:var(--dsw-alias-state-idle-primary)}
.msm-dot[data-state="ok"]{background:var(--dsw-alias-state-success-primary)}
.msm-dot[data-state="loading"]{background:var(--dsw-alias-state-warn-primary)}
.msm-dot[data-state="failed"]{background:var(--dsw-alias-state-error-primary)}
.msm-card-error{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary);overflow-wrap:anywhere}
.msm-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.msm-btn{display:inline-flex;align-items:center;gap:6px;border:1px solid transparent;border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer;font-family:inherit;font-size:13px;line-height:18px;padding:6px 12px}
.msm-btn:disabled{opacity:.55;cursor:default}
.msm-btn-primary{background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base)}
.msm-btn-secondary{border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}
.msm-btn-ghost{color:var(--dsw-alias-label-secondary)}
.msm-btn-ghost:hover:not(:disabled){color:var(--dsw-alias-label-primary);background:color-mix(in srgb,var(--dsw-alias-label-secondary) 12%,transparent)}
.msm-btn-danger{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 40%,transparent)}
.msm-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.msm-switch{position:relative;width:34px;height:20px;flex:none;padding:0;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;background:var(--dsw-alias-bg-layer-2);cursor:pointer}
.msm-switch:disabled{opacity:.55;cursor:default}
.msm-switch[aria-checked="true"]{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}
.msm-switch-knob{position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:999px;background:var(--dsw-alias-bg-base);transition:transform .15s ease}
.msm-switch[aria-checked="true"] .msm-switch-knob{transform:translateX(14px)}
.msm-switch:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.msm-input,.msm-select,.msm-textarea{box-sizing:border-box;width:100%;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:13px;line-height:18px;padding:7px 10px}
.msm-textarea{min-height:72px;resize:vertical;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;line-height:18px}
.msm-mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;line-height:18px}
.msm-input:focus,.msm-select:focus,.msm-textarea:focus{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:0;border-color:transparent}
.msm-field{display:flex;flex-direction:column;gap:5px;min-width:0}
.msm-label{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.msm-grid-2{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.msm-check{display:inline-flex;align-items:center;gap:8px;font-size:13px;line-height:18px;color:var(--dsw-alias-label-primary);cursor:pointer}
.msm-check input{width:15px;height:15px;accent-color:var(--dsw-alias-brand-primary);margin:0}
.msm-dialog{border:0;padding:0;margin:auto;background:transparent;width:100%;max-width:min(560px,calc(100vw - 48px));max-height:calc(100vh - 48px)}
.msm-dialog::backdrop{background:rgb(0 0 0 / 42%)}
.msm-modal{display:flex;flex-direction:column;width:100%;max-height:calc(100vh - 48px);overflow:hidden;border:1px solid var(--dsw-alias-border-l1);border-radius:14px;background:var(--dsw-alias-bg-overlay);box-shadow:0 18px 48px rgb(0 0 0 / 30%)}
.msm-modal-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:16px 18px 8px}
.msm-modal-title{margin:0;font-size:16px;font-weight:600;line-height:22px}
.msm-icon-btn{border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-family:inherit;font-size:18px;line-height:1;padding:4px 8px}
.msm-icon-btn:hover{color:var(--dsw-alias-label-primary);background:color-mix(in srgb,var(--dsw-alias-label-secondary) 12%,transparent)}
.msm-icon-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.msm-modal-body{display:flex;flex-direction:column;gap:14px;padding:4px 18px 12px;overflow:auto}
.msm-modal-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:12px 18px 16px;border-top:1px solid var(--dsw-alias-border-l1)}
.msm-foot-right{display:flex;gap:8px;margin-left:auto}
.msm-banner{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:10px 12px;font-size:12px;line-height:18px}
.msm-banner[data-kind="error"]{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 40%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,transparent);color:var(--dsw-alias-state-error-primary)}
.msm-banner[data-kind="info"]{color:var(--dsw-alias-label-secondary)}
.msm-empty{display:flex;flex-direction:column;align-items:center;gap:8px;padding:28px 16px;border:1px dashed var(--dsw-alias-border-l2);border-radius:12px;text-align:center}
.msm-empty-title{margin:0;font-size:13px;font-weight:500;line-height:20px;color:var(--dsw-alias-label-primary)}
.msm-empty-text{margin:0;max-width:520px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.msm-skill-list{list-style:none;margin:0;padding:0;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);overflow:hidden}
.msm-skill{display:flex;flex-direction:column;gap:4px;padding:12px 16px;border-top:1px solid var(--dsw-alias-border-l1)}
.msm-skill:first-child{border-top:0}
.msm-skill-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.msm-skill-name{font-size:13px;font-weight:600;line-height:20px}
.msm-skill-desc{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.msm-skill-path{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.msm-badge{border-radius:4px;background:color-mix(in srgb,var(--dsw-alias-label-secondary) 12%,transparent);color:var(--dsw-alias-label-secondary);font-size:10px;line-height:16px;padding:0 5px}
.msm-badge[data-on="true"]{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 12%,transparent);color:var(--dsw-alias-state-success-primary)}
.msm-root-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:8px 0;border-top:1px solid var(--dsw-alias-border-l1)}
.msm-root-row:first-child{border-top:0}
.msm-root-path{flex:1 1 260px;overflow-wrap:anywhere;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;line-height:18px}
.msm-inline-form{display:flex;align-items:flex-end;gap:8px;flex-wrap:wrap}
.msm-inline-form .msm-field{flex:1 1 260px}
.msm-footer-note{margin:0;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.msm-loading{padding:24px 0;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;margin:0}
.msm-search-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.msm-search{max-width:280px}
.msm-filters{display:inline-flex;gap:4px;flex-wrap:wrap}
.msm-loading-btn{opacity:.7}
.msm-status-wrap{position:relative;display:inline-flex}
.msm-status-chip{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:12px;line-height:18px;padding:4px 10px;cursor:pointer;white-space:nowrap}
.msm-status-chip:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2)}
.msm-status-chip:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.msm-status-dot{width:7px;height:7px;border-radius:999px;background:var(--dsw-alias-state-success-primary);flex:none}
.msm-popover{position:absolute;top:calc(100% + 6px);right:8px;z-index:40;width:min(340px,calc(100vw - 48px));max-height:min(460px,60vh);overflow:auto;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-overlay);box-shadow:0 12px 32px rgb(0 0 0 / 22%);padding:12px;display:flex;flex-direction:column;gap:10px}
.msm-pop-title{margin:0;font-size:13px;font-weight:600;line-height:20px}
.msm-pop-section{display:flex;flex-direction:column;gap:4px}
.msm-pop-head{margin:0;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.msm-pop-row{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary)}
.msm-tool-card{margin:2px 0;max-width:640px;display:flex;flex-direction:column;gap:6px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}
.msm-tool-row{flex-direction:row;align-items:center;gap:8px;flex-wrap:wrap}
.msm-tool-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.msm-tool-title{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary)}
.msm-tool-chip{font-size:11px;line-height:16px;padding:0 6px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent);color:var(--dsw-alias-brand-primary)}
.msm-tool-sub{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.msm-tool-link{margin-left:auto;padding:2px 4px;border:0;border-radius:4px;background:transparent;color:var(--dsw-alias-brand-primary);font-family:inherit;font-size:11px;cursor:pointer}
.msm-tool-shot{display:block;max-width:100%;max-height:260px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-base);object-fit:contain;cursor:zoom-in}
.msm-tool-shot.is-expanded{max-height:none;cursor:zoom-out}
.msm-tool-meta{margin:0;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.msm-banner[data-kind="success"]{border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 40%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 8%,transparent);color:var(--dsw-alias-state-success-primary)}
.msm-cu{box-sizing:border-box;padding:0 clamp(16px,3vw,32px) 200px}
.msm-cu-inner{display:flex;flex-direction:column;gap:12px;max-width:960px;margin:0 auto;padding-top:8px}
.msm-cu .msm-empty{margin:12px 0 0}
.msm-cu-head{position:sticky;top:0;z-index:2;display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap;background:var(--dsw-alias-bg-base);padding:16px 0 10px}
.msm-cu-heading{min-width:0}
.msm-cu-title{margin:0;font-size:16px;font-weight:600;line-height:24px}
.msm-cu-hint{margin:2px 0 0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.msm-cu-filters{display:inline-flex;gap:4px;padding:3px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);flex-wrap:wrap}
.msm-cu-filter{border:0;background:transparent;color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:12px;line-height:16px;padding:5px 10px;border-radius:8px;cursor:pointer;white-space:nowrap}
.msm-cu-filter:hover{color:var(--dsw-alias-label-primary)}
.msm-cu-filter[aria-pressed="true"]{background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);box-shadow:inset 0 0 0 1px var(--dsw-alias-border-l1)}
.msm-cu-filter:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.msm-cu-summary{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.msm-cu-round{border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);overflow:hidden}
.msm-cu-round-head{display:flex;align-items:center;gap:8px;width:100%;padding:10px 14px;border:0;background:transparent;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:13px;line-height:20px;text-align:left;cursor:pointer}
.msm-cu-round-head:hover{background:color-mix(in srgb,var(--dsw-alias-label-secondary) 8%,transparent)}
.msm-cu-round-head:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.msm-cu-round-title{font-weight:600}
.msm-cu-round-meta{margin-left:auto;color:var(--dsw-alias-label-secondary);font-size:12px;white-space:nowrap}
.msm-cu-round-body{display:flex;flex-direction:column;border-top:1px solid var(--dsw-alias-border-l1)}
.msm-cu-op{display:flex;gap:12px;padding:10px 14px;border-top:1px solid var(--dsw-alias-border-l1)}
.msm-cu-op:first-child{border-top:0}
.msm-cu-op[data-state="running"]{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 6%,transparent)}
.msm-cu-op-main{display:flex;flex-direction:column;gap:6px;min-width:0;flex:1}
.msm-cu-op-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.msm-cu-op-kind{font-size:12px;font-weight:600}
.msm-cu-op-time{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.msm-cu-op-text{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}
.msm-cu-op-note{margin:0;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.msm-cu-shot{display:block;max-width:min(100%,520px);max-height:220px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-base);object-fit:contain;cursor:zoom-in}
.msm-cu-shot.is-large{max-height:none;max-width:100%;cursor:zoom-out}
.msm-cu-mark{position:relative;display:block;width:min(100%,520px);margin-top:2px}
.msm-cu-mark-img{display:block;width:100%;height:auto;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-base)}
.msm-cu-mark-box{position:absolute;width:26px;height:26px;transform:translate(-50%,-50%);border:2px solid #e5484d;border-radius:5px;box-shadow:0 0 0 1px rgb(255 255 255 / 85%);pointer-events:none}
.msm-cu-mark-box::after{content:'';position:absolute;left:50%;top:50%;width:6px;height:6px;margin:-3px 0 0 -3px;border-radius:50%;background:#e5484d;box-shadow:0 0 0 1px rgb(255 255 255 / 90%)}
.msm-cu-mark-drag{position:absolute;border:2px dashed #e5484d;border-radius:5px;background:rgb(229 72 77 / 12%);pointer-events:none}
.msm-cu-error{color:var(--dsw-alias-state-error-primary)}
.msm-tool-card[data-refused="true"]{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 7%,transparent)}
.msm-tool-badge-refused{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 14%,transparent);color:var(--dsw-alias-state-error-primary)}
.msm-tool-code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:10px;line-height:16px;padding:0 5px;border:1px solid color-mix(in srgb,var(--dsw-alias-state-error-primary) 35%,transparent);border-radius:4px;color:var(--dsw-alias-state-error-primary);white-space:nowrap}
.msm-tool-token{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:10px;line-height:16px;padding:0 6px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-label-secondary) 12%,transparent);color:var(--dsw-alias-label-secondary);white-space:nowrap}
.msm-tool-error{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary);overflow-wrap:anywhere}
.msm-tool-check{margin:0;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:10px;line-height:16px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.msm-tool-pre{margin:0;max-height:200px;overflow:auto;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:10px;line-height:16px;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;overflow-wrap:anywhere}
.msm-tool-pre.is-expanded{max-height:none}
.msm-cu-status{display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.msm-cu-status[data-stale="true"]{opacity:.6}
.msm-cu-status-item{display:inline-flex;align-items:center;gap:5px;white-space:nowrap}
.msm-cu-status-dot{width:7px;height:7px;border-radius:999px;flex:none;background:var(--dsw-alias-state-success-primary)}
.msm-cu-status-dot[data-paused="true"]{background:var(--dsw-alias-state-warn-primary)}
.msm-cap-wrap{position:relative;display:inline-flex}
.msm-cap-btn{display:inline-flex;align-items:center;gap:6px;border:0;border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:12px;line-height:16px;padding:4px 8px;cursor:pointer}
.msm-cap-btn:hover{color:var(--dsw-alias-label-primary);background:color-mix(in srgb,var(--dsw-alias-label-secondary) 12%,transparent)}
.msm-cap-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.msm-cap-dot{width:7px;height:7px;border-radius:999px;flex:none;background:var(--dsw-alias-label-caption)}
.msm-cap-dot[data-on="true"]{background:var(--dsw-alias-state-success-primary)}
.msm-cap-count{border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 14%,transparent);color:var(--dsw-alias-brand-primary);font-size:10px;line-height:16px;padding:0 5px}
.msm-cap-pop{position:absolute;bottom:calc(100% + 8px);left:0;z-index:50;width:min(330px,calc(100vw - 32px));border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-overlay);box-shadow:0 12px 32px rgb(0 0 0 / 22%);padding:12px;display:flex;flex-direction:column;gap:10px}
.msm-cap-title{margin:0;font-size:13px;font-weight:600;line-height:20px}
.msm-cap-hint{margin:0;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.msm-cap-tools{margin:0;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:10px;line-height:16px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.msm-cap-row{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}
.msm-cap-row-text{display:flex;flex-direction:column;gap:2px;min-width:0}
.msm-cap-label{font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary)}
.msm-cap-error{margin:0;font-size:11px;line-height:16px;color:var(--dsw-alias-state-error-primary)}
.msm-mkt-entry{display:flex;flex-direction:column;gap:6px;padding-top:8px;border-top:1px solid var(--dsw-alias-border-l1)}
.msm-mkt-entry-btn{align-self:flex-start}
.msm-mkt-overlay{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:24px;background:rgb(0 0 0 / 45%)}
.msm-mkt-panel{display:flex;flex-direction:column;width:min(720px,calc(100vw - 32px));max-height:min(720px,calc(100vh - 48px));overflow:hidden;border:1px solid var(--dsw-alias-border-l1);border-radius:14px;background:var(--dsw-alias-bg-overlay);box-shadow:0 18px 48px rgb(0 0 0 / 30%)}
.msm-mkt-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 16px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.msm-mkt-title{margin:0;font-size:15px;font-weight:600;line-height:22px}
.msm-mkt-body{display:flex;flex-direction:column;gap:10px;padding:14px 16px;overflow:auto}
.msm-mkt-search{max-width:none}
.msm-mkt-list{display:flex;flex-direction:column;gap:8px}
.msm-mkt-row{display:flex;align-items:flex-start;gap:12px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}
.msm-mkt-row-main{display:flex;flex-direction:column;gap:3px;min-width:0;flex:1}
.msm-mkt-row-head{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.msm-mkt-name{font-size:13px;font-weight:600;line-height:18px}
.msm-mkt-pkg{font-size:10px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.msm-mkt-desc{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.msm-mkt-meta{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin:0;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.msm-mkt-source{border:1px solid var(--dsw-alias-border-l1);border-radius:4px;font-size:10px;line-height:16px;padding:0 4px}
.msm-mkt-chip{border-radius:999px;font-size:10px;line-height:16px;padding:0 6px;background:color-mix(in srgb,var(--dsw-alias-label-secondary) 12%,transparent);color:var(--dsw-alias-label-secondary)}
.msm-mkt-chip[data-kind="verified"]{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 14%,transparent);color:var(--dsw-alias-state-success-primary)}
.msm-mkt-chip[data-kind="risk"]{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 14%,transparent);color:var(--dsw-alias-brand-primary)}
.msm-mkt-row-action{display:flex;align-items:flex-end;flex:none}
.msm-mkt-empty,.msm-mkt-loading{padding:18px 8px;text-align:center;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.msm-mkt-failures{display:flex;flex-direction:column;gap:2px;padding-top:8px;border-top:1px solid var(--dsw-alias-border-l1)}
.msm-mkt-failures-title{margin:0;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.msm-mkt-failure{margin:0;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:10px;line-height:16px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.msm-mkt-error{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary);overflow-wrap:anywhere}
.msm-mkt-section-title{margin:0;font-size:13px;font-weight:600;line-height:20px}
.msm-mkt-fields{display:flex;flex-direction:column;gap:4px}
.msm-mkt-field{display:flex;gap:8px;align-items:baseline;font-size:12px;line-height:18px}
.msm-mkt-field-label{flex:none;min-width:56px;color:var(--dsw-alias-label-secondary)}
.msm-mkt-field-value{min-width:0;overflow-wrap:anywhere}
.msm-mkt-spec{margin:0;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;line-height:16px;overflow-wrap:anywhere}
.msm-mkt-risk{margin:0;padding:8px 10px;border:1px solid color-mix(in srgb,var(--dsw-alias-state-warn-primary) 40%,transparent);border-radius:8px;background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 8%,transparent);font-size:11px;line-height:17px;color:var(--dsw-alias-label-secondary)}
.msm-mkt-actions{display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap}
.msm-mkt-progress{display:flex;flex-direction:column;gap:8px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary)}
.msm-mkt-hint{margin:0;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.msm-mkt-result{display:flex;flex-direction:column;gap:8px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary)}
.msm-mkt-result-line{margin:0;overflow-wrap:anywhere}
.msm-mkt-result-line[data-tone="error"]{color:var(--dsw-alias-state-error-primary)}
.msm-mkt-result-line[data-tone="warn"]{color:var(--dsw-alias-state-warn-primary)}
.msm-mkt-result-line[data-tone="success"]{color:var(--dsw-alias-state-success-primary)}
.msm-mkt-diagnostic{margin:4px 0 0;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.msm-mkt-diagnostic pre{margin:6px 0 0;max-height:180px;overflow:auto;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:10px;line-height:15px;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;overflow-wrap:anywhere}
@media (max-width:640px){.msm-grid-2{grid-template-columns:1fr}.msm-page{padding:0 16px 32px}}
.msm-cap-bar{box-sizing:border-box;display:flex;align-items:center;justify-content:space-between;gap:16px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);padding:10px 14px}
.msm-cap-bar[data-on="true"]{border-color:var(--dsw-alias-brand-primary)}
.msm-cap-bar[data-stale="true"]{opacity:.7}
.msm-cap-bar-text{display:flex;flex-direction:column;gap:2px;min-width:0}
.msm-cap-bar-label{font-size:13px;line-height:20px;font-weight:500;color:var(--dsw-alias-label-primary)}
.msm-cap-bar-hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);word-break:break-word}
@media (max-width:640px){.msm-cap-bar{flex-direction:column;align-items:flex-start}}
`

    // -----------------------------------------------------------------
    // Routes and UI atoms
    // -----------------------------------------------------------------

    function browserUseStatusUrl(sessionId) {
      const base = typeof document !== 'undefined' && document.baseURI ? document.baseURI : window.location.href
      const query = typeof sessionId === 'string' && sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''
      try {
        const url = new URL(BU_STATUS_SUFFIX, base)
        if (query) url.searchParams.set('sessionId', sessionId)
        return url.href
      } catch {
        return `/${BU_STATUS_SUFFIX}${query}`
      }
    }

    /**
     * Read the `{ok,value}` envelope of the browser-use status route, or write
     * a pause/close action to it when `body` is given. Callers swallow
     * failures: the chip and the tab are optional UI and must degrade quietly
     * when the Host half is absent or disabled.
     */
    async function browserUseStatus(body, sessionId) {
      const options = {
        method: body === undefined ? 'GET' : 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: {},
      }
      if (body !== undefined) {
        options.headers['content-type'] = 'application/json'
        options.body = JSON.stringify(body)
      }
      const response = await fetch(browserUseStatusUrl(sessionId), options)
      let payload
      try {
        payload = await response.json()
      } catch {
        payload = null
      }
      const hostReason = payload && payload.error && typeof payload.error.message === 'string' ? payload.error.message : ''
      if (!response.ok) throw new Error(hostReason || `HTTP ${response.status} ${response.statusText}`)
      if (!payload || payload.ok !== true) throw new Error(hostReason || 'The browser-use route rejected the request.')
      return payload.value === undefined ? null : payload.value
    }

    function browserCapabilityUrl(sessionId) {
      const base = typeof document !== 'undefined' && document.baseURI ? document.baseURI : window.location.href
      const query = typeof sessionId === 'string' && sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''
      try {
        const url = new URL(BU_CAPABILITY_SUFFIX, base)
        if (query) url.searchParams.set('sessionId', sessionId)
        return url.href
      } catch {
        return `/${BU_CAPABILITY_SUFFIX}${query}`
      }
    }

    /**
     * Read `{enabled}` from the capability route, or set it when `body` is
     * given. The Host stores the flag in ~/.dsh/capability-toggles.json, which
     * is what gates the browser tools, so a saved value applies on the next
     * step rather than retroactively.
     */
    async function browserCapability(body, sessionId) {
      const options = {
        method: body === undefined ? 'GET' : 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: {},
      }
      if (body !== undefined) {
        options.headers['content-type'] = 'application/json'
        options.body = JSON.stringify(body)
      }
      const response = await fetch(browserCapabilityUrl(body === undefined ? sessionId : undefined), options)
      let payload
      try {
        payload = await response.json()
      } catch {
        payload = null
      }
      const hostReason = payload && payload.error && typeof payload.error.message === 'string' ? payload.error.message : ''
      if (!response.ok) throw new Error(hostReason || `HTTP ${response.status} ${response.statusText}`)
      if (!payload || payload.ok !== true) throw new Error(hostReason || 'The browser-use capability route rejected the request.')
      const value = payload.value && typeof payload.value === 'object' ? payload.value : payload
      return { enabled: value.enabled === true }
    }

    function messageOf(error) {
      if (!error) return 'Unknown error'
      return typeof error.message === 'string' && error.message ? error.message : String(error)
    }

    function cx(...parts) {
      return parts.filter(Boolean).join(' ')
    }

    function Btn({ variant, className, disabled, onClick, children, title }) {
      return h(
        'button',
        {
          type: 'button',
          className: cx('msm-btn', variant ? `msm-btn-${variant}` : null, className),
          disabled,
          onClick,
          title,
        },
        children,
      )
    }

    function Switch({ checked, disabled, label, onToggle }) {
      return h(
        'button',
        {
          type: 'button',
          role: 'switch',
          'aria-checked': checked ? 'true' : 'false',
          'aria-label': label,
          title: label,
          className: 'msm-switch',
          disabled,
          onClick: onToggle,
        },
        h('span', { className: 'msm-switch-knob' }),
      )
    }

    // -----------------------------------------------------------------
    // Per-session browser-control switch (top of the 浏览器 tab)
    // -----------------------------------------------------------------

    /**
     * Off by default. The switch is not local state: it writes the Host store
     * that the browser tools' `when` predicate reads, and the tab labels the
     * saved value "applies on the next step" so the delay is never a surprise.
     */
    function BrowserCapabilityBar({ t, sessionId }) {
      const [state, setState] = React.useState({ enabled: null, stale: false, saving: false })
      const [notice, setNotice] = React.useState('')
      const alive = React.useRef(true)
      const load = React.useCallback(async () => {
        if (typeof sessionId !== 'string' || sessionId === '') return
        try {
          const value = await browserCapability(undefined, sessionId)
          if (alive.current) setState({ enabled: value.enabled === true, stale: false, saving: false })
        } catch {
          // Unknown state: keep the bar visible but disable the switch instead
          // of claiming the capability is off.
          if (alive.current) setState((current) => ({ ...current, stale: true }))
        }
      }, [sessionId])
      React.useEffect(() => {
        alive.current = true
        void load()
        return () => {
          alive.current = false
        }
      }, [load])

      const enabled = state.enabled === true
      const known = state.enabled !== null
      const toggle = async () => {
        if (!known || state.saving || state.stale || !sessionId) return
        const next = !enabled
        setState((current) => ({ ...current, saving: true }))
        setNotice('')
        try {
          const value = await browserCapability({ sessionId, enabled: next }, sessionId)
          if (!alive.current) return
          setState({ enabled: value.enabled === true, stale: false, saving: false })
          setNotice(t('browserCapabilityPending'))
        } catch (error) {
          if (!alive.current) return
          setState((current) => ({ ...current, saving: false }))
          setNotice(`${t('browserCapabilityFailed')} — ${messageOf(error)}`)
        }
      }

      const label = !known ? t('browserCapabilityLoading') : enabled ? t('browserCapabilityOn') : t('browserCapabilityOff')
      const hint = notice || (state.stale ? t('browserStatusOffline') : t('browserCapabilityHint'))
      return h(
        'div',
        {
          className: 'msm-cap-bar',
          'data-on': enabled ? 'true' : 'false',
          'data-stale': state.stale ? 'true' : undefined,
          role: 'group',
          'aria-label': t('browserCapabilitySwitch'),
        },
        h(
          'div',
          { className: 'msm-cap-bar-text' },
          h('span', { className: 'msm-cap-bar-label' }, label),
          h('span', { className: 'msm-cap-bar-hint' }, hint),
        ),
        h(Switch, {
          checked: enabled,
          disabled: !known || state.saving || state.stale,
          label: enabled ? t('browserCapabilityDisable') : t('browserCapabilityEnable'),
          onToggle: () => void toggle(),
        }),
      )
    }

    function normalizeBrowserStatus(value) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return null
      return {
        paused: value.paused === true,
        instances: Array.isArray(value.instances)
          ? value.instances.filter((instance) => instance && typeof instance === 'object' && !Array.isArray(instance))
          : [],
      }
    }

    /**
     * Compact browser-use status in the composer, right after the capability
     * switches. It only exists while a browser is open or browser actions are
     * paused; the route is optional (the Host half may be old/disabled), so a
     * failure hides the chip (`null`, no empty shell) and a failure after a
     * visible state keeps that state greyed until the next answer.
     */
    function BrowserStatus({ t, sessionId }) {
      const [state, setState] = React.useState({ value: null, stale: false })
      const [busy, setBusy] = React.useState(false)
      const alive = React.useRef(true)
      const load = React.useCallback(async () => {
        try {
          const value = normalizeBrowserStatus(await browserUseStatus(undefined, sessionId))
          if (alive.current) setState({ value, stale: false })
        } catch {
          // Never surface the route error: keep the last known state on a
          // transient poll failure, but never resurrect a chip that was never
          // available, so an absent route stays completely invisible.
          if (alive.current) {
            setState((current) => (current.value === null ? current : { value: current.value, stale: true }))
          }
        }
      }, [sessionId])
      React.useEffect(() => {
        alive.current = true
        void load()
        const timer = setInterval(() => void load(), 10000)
        return () => {
          alive.current = false
          clearInterval(timer)
        }
      }, [load])

      const value = normalizeBrowserStatus(state.value)
      if (!value) return null
      const paused = value.paused === true
      const instances = value.instances
      if (!paused && instances.length === 0) return null

      const togglePause = async () => {
        if (busy || state.stale) return
        setBusy(true)
        try {
          await browserUseStatus({ action: paused ? 'resume' : 'pause' }, sessionId)
        } catch {
          // The follow-up GET decides how to degrade; the error stays here.
        } finally {
          if (alive.current) setBusy(false)
        }
        if (!alive.current) return
        await load()
      }
      const actionLabel = paused ? t('browserResume') : t('browserPause')
      return h(
        'div',
        {
          className: 'msm-cu-status msm-cap-wrap',
          role: 'group',
          'aria-label': t('browserChip'),
          'data-stale': state.stale ? 'true' : undefined,
          title: state.stale ? t('browserStatusOffline') : t('browserChip'),
        },
        h(
          'span',
          { className: 'msm-status', 'aria-live': 'polite' },
          h('span', { className: 'msm-cu-status-dot', 'data-paused': paused ? 'true' : 'false' }),
          paused ? t('browserPaused') : t('browserRunning'),
          h('span', { className: 'msm-cap-count' }, t('browserInstances', { n: instances.length })),
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'msm-btn msm-cap-btn',
            disabled: busy || state.stale,
            title: actionLabel,
            onClick: () => void togglePause(),
          },
          actionLabel,
        ),
      )
    }


    // -----------------------------------------------------------------
    // Browser tool cards (stage 2, iteration 2)
    // -----------------------------------------------------------------

    /** Route-safe PNG basename accepted by /api/browser-use/shot. */
    const BROWSER_SHOT_FILE = /^[A-Za-z0-9._-]+\.png$/
    /** Lines shown before the observe card collapses. */
    const BROWSER_OBSERVE_LINES = 40
    /** Lines shown before a console/network/tabs list collapses. */
    const BROWSER_LIST_LINES = 12

    function browserString(value) {
      return typeof value === 'string' ? value : ''
    }

    /** The presentation metadata of a finished browser call, if any. */
    function browserMetaOf(phase, block) {
      if (phase !== 'result' || !block || typeof block !== 'object') return undefined
      const meta = block.meta
      return meta && typeof meta === 'object' ? meta : undefined
    }

    function browserRendered(meta) {
      return meta && typeof meta.rendered === 'string' ? meta.rendered : ''
    }

    function browserLines(text) {
      const value = browserString(text)
      if (!value) return []
      return value.replace(/\r\n?/g, '\n').split('\n')
    }

    /** First non-empty line, trimmed; used for one-line summaries. */
    function browserHeadLine(text) {
      for (const line of browserLines(text)) if (line.trim()) return line.trim()
      return ''
    }

    function browserClip(text, max) {
      const value = browserString(text)
      if (!value) return ''
      return value.length > max ? `${value.slice(0, max)}…` : value
    }

    function browserParagraphs(text) {
      const value = browserString(text)
      if (!value) return []
      return value
        .split(/\n\s*\n/)
        .map((part) => part.trim())
        .filter(Boolean)
    }

    /** Host part of meta.url, or '' when the URL is absent or invalid. */
    function browserHost(url) {
      const value = browserString(url)
      if (!value) return ''
      try {
        return new URL(value).host || ''
      } catch {
        return ''
      }
    }

    /** Basename of a screenshot path; the shot route only serves that name. */
    function browserShotFile(meta) {
      const path = meta && typeof meta.path === 'string' ? meta.path.trim() : ''
      if (!path) return ''
      const parts = path.split(/[\\/]/)
      return parts[parts.length - 1] || ''
    }

    /**
     * Screenshot URL on the dsh-browser-use route. Deliberately not shotUrl():
     * desktop screenshots live on api/computer-use/shot instead.
     */
    function browserShotUrl(file) {
      const base = typeof document !== 'undefined' && document.baseURI ? document.baseURI : window.location.href
      try {
        const url = new URL('api/browser-use/shot', base)
        url.searchParams.set('file', file)
        return url.href
      } catch {
        return `api/browser-use/shot?file=${encodeURIComponent(file)}`
      }
    }

    /** `+N/-M` control diff, or '' when the host did not report one. */
    function browserChangedText(changed) {
      if (!changed || typeof changed !== 'object') return ''
      const added = typeof changed.added === 'number' && Number.isFinite(changed.added) ? changed.added : null
      const removed = typeof changed.removed === 'number' && Number.isFinite(changed.removed) ? changed.removed : null
      if (added === null && removed === null) return ''
      return `+${added === null ? '?' : added}/-${removed === null ? '?' : removed}`
    }

    /** Up to five added controls, labelled `ref role "name"`. */
    function browserAddedControls(changed) {
      if (!changed || !Array.isArray(changed.addedControls)) return []
      const names = []
      for (const item of changed.addedControls.slice(0, 5)) {
        if (!item || typeof item !== 'object') continue
        const ref = browserString(item.ref)
        const role = browserString(item.role)
        const name = browserString(item.name)
        const text = [ref, role, name ? `"${name}"` : ''].filter(Boolean).join(' ')
        if (text) names.push(text)
      }
      return names
    }

    function browserToggle(t, expanded, onToggle) {
      return h(
        'button',
        { type: 'button', className: 'msm-tool-link', key: 'toggle', onClick: onToggle },
        expanded ? t('shrink') : t('enlarge'),
      )
    }

    /**
     * Shared frame for the six browser cards. The refusal state reuses the
     * desktop-action visuals (refused badge, code, message, guidance); missing
     * meta fields simply leave the body empty instead of throwing.
     */
    function BrowserCard({ t, phase, block, title, headExtras, renderBody }) {
      const done = phase === 'result'
      const meta = browserMetaOf(phase, block)
      const refused = done && meta !== undefined && meta.ok === false
      const code = refused ? browserString(meta.code) : ''
      const message = refused ? browserString(meta.message) : ''
      const guidance = refused ? browserString(meta.guidance) : ''
      const extras = typeof headExtras === 'function' ? headExtras(meta, done, refused) : headExtras
      const head = [h('span', { className: 'msm-tool-title', key: 'title' }, title)]
      if (Array.isArray(extras)) {
        for (const extra of extras) if (extra) head.push(extra)
      } else if (extras) {
        head.push(extras)
      }
      if (refused) head.push(h('span', { className: 'msm-badge msm-tool-badge-refused', key: 'refused' }, t('cuRefused')))
      if (code) head.push(h('span', { className: 'msm-tool-code', key: 'code' }, code))
      if (!done) head.push(h('span', { className: 'msm-tool-sub', key: 'running' }, t('running')))
      const children = [h('div', { className: 'msm-tool-head', key: 'head' }, head)]
      if (refused && message) children.push(h('p', { className: 'msm-tool-error', key: 'message' }, message))
      if (refused && guidance) children.push(h('p', { className: 'msm-tool-meta', key: 'guidance' }, guidance))
      if (done && !refused && typeof renderBody === 'function') {
        const body = renderBody(meta)
        if (Array.isArray(body)) {
          for (const item of body) if (item) children.push(item)
        } else if (body) {
          children.push(body)
        }
      }
      return h(
        'div',
        { className: 'msm-tool-card', 'data-refused': refused ? 'true' : undefined },
        children,
      )
    }

    function BrowserObserveToolView({ t, phase, block }) {
      const [expanded, setExpanded] = React.useState(false)
      return h(BrowserCard, {
        t,
        phase,
        block,
        title: t('browserObserve'),
        headExtras: (meta, done, refused) => {
          if (!done || refused) return null
          const host = browserHost(meta && meta.url)
          const pageTitle = browserClip(browserString(meta && meta.title), 90)
          const lines = browserLines(browserRendered(meta))
          return [
            host ? h('span', { className: 'msm-tool-chip', key: 'host' }, host) : null,
            pageTitle ? h('span', { className: 'msm-tool-sub', key: 'page' }, pageTitle) : null,
            lines.length > BROWSER_OBSERVE_LINES
              ? browserToggle(t, expanded, () => setExpanded((value) => !value))
              : null,
          ]
        },
        renderBody: (meta) => {
          const rendered = browserRendered(meta)
          if (!rendered) {
            const url = browserString(meta && meta.url)
            return url ? h('p', { className: 'msm-tool-meta', key: 'url' }, url) : null
          }
          const lines = browserLines(rendered)
          const shown = expanded ? lines : lines.slice(0, BROWSER_OBSERVE_LINES)
          return h(
            'pre',
            { className: cx('msm-tool-pre', expanded ? 'is-expanded' : null), key: 'rendered' },
            shown.join('\n'),
          )
        },
      })
    }

    function BrowserActToolView({ t, phase, block }) {
      return h(BrowserCard, {
        t,
        phase,
        block,
        title: t('browserAct'),
        headExtras: (meta, done, refused) => {
          if (!done || refused) return null
          const action = browserString(meta && meta.action)
          const target = browserClip(browserString(meta && meta.target), 120)
          const diff = browserChangedText(meta && meta.changed)
          return [
            action ? h('span', { className: 'msm-tool-chip', key: 'action' }, action) : null,
            target ? h('span', { className: 'msm-tool-sub msm-mono', key: 'target' }, target) : null,
            diff ? h('span', { className: 'msm-tool-token', key: 'diff' }, diff) : null,
          ]
        },
        renderBody: (meta) => {
          const added = browserAddedControls(meta && meta.changed)
          if (!added.length) return null
          return h('p', { className: 'msm-tool-sub', key: 'added' }, added.join(' · '))
        },
      })
    }

    function BrowserReadToolView({ t, phase, block }) {
      const [expanded, setExpanded] = React.useState(false)
      return h(BrowserCard, {
        t,
        phase,
        block,
        title: t('browserRead'),
        headExtras: (meta, done, refused) => {
          if (!done || refused) return null
          const pageTitle = browserClip(browserString(meta && meta.title), 90)
          const host = browserHost(meta && meta.url)
          const rendered = browserRendered(meta)
          const collapsible = rendered.length > 600 || browserLines(rendered).length > 4
          return [
            pageTitle ? h('span', { className: 'msm-tool-sub', key: 'page' }, pageTitle) : null,
            host ? h('span', { className: 'msm-tool-chip', key: 'host' }, host) : null,
            collapsible ? browserToggle(t, expanded, () => setExpanded((value) => !value)) : null,
          ]
        },
        renderBody: (meta) => {
          const rendered = browserRendered(meta)
          if (!rendered) return null
          const paragraphs = browserParagraphs(rendered)
          const summary = paragraphs.length ? paragraphs.slice(0, 3).join('\n\n') : rendered
          const text = expanded ? rendered : browserClip(summary, 600)
          return h(
            'pre',
            { className: cx('msm-tool-pre', expanded ? 'is-expanded' : null), key: 'rendered' },
            text,
          )
        },
      })
    }

    function BrowserEvidenceToolView({ t, phase, block }) {
      const [expanded, setExpanded] = React.useState(false)
      return h(BrowserCard, {
        t,
        phase,
        block,
        title: t('browserEvidence'),
        headExtras: (meta, done, refused) => {
          if (!done || refused) return null
          const kind = browserString(meta && meta.kind)
          const host = browserHost(meta && meta.url)
          const label = kind === 'console' ? t('browserConsole') : kind === 'network' ? t('browserNetwork') : ''
          const isList = kind === 'console' || kind === 'network'
          const lines = browserLines(browserRendered(meta))
          return [
            label ? h('span', { className: 'msm-tool-chip', key: 'kind' }, label) : null,
            host ? h('span', { className: 'msm-tool-sub', key: 'host' }, host) : null,
            isList && lines.length > BROWSER_LIST_LINES
              ? browserToggle(t, expanded, () => setExpanded((value) => !value))
              : null,
          ]
        },
        renderBody: (meta) => {
          const kind = browserString(meta && meta.kind)
          const isList = kind === 'console' || kind === 'network'
          const file = browserShotFile(meta)
          const shot = !isList && BROWSER_SHOT_FILE.test(file) ? file : ''
          const lines = browserLines(browserRendered(meta))
          const body = []
          if (shot) {
            body.push(
              h('img', {
                className: cx('msm-tool-shot', expanded ? 'is-expanded' : null),
                src: browserShotUrl(shot),
                alt: t('browserEvidence'),
                loading: 'lazy',
                key: 'shot',
                onClick: () => setExpanded((value) => !value),
              }),
            )
          } else if (lines.length) {
            const shown = expanded ? lines : lines.slice(0, BROWSER_LIST_LINES)
            body.push(
              h(
                'pre',
                { className: cx('msm-tool-pre', expanded ? 'is-expanded' : null), key: 'rendered' },
                shown.join('\n'),
              ),
            )
          }
          if (file && !shot) body.push(h('p', { className: 'msm-tool-meta', key: 'file' }, file))
          return body
        },
      })
    }

    function BrowserOpenToolView({ t, phase, block }) {
      return h(BrowserCard, {
        t,
        phase,
        block,
        title: t('browserOpen'),
        headExtras: (meta, done, refused) => {
          if (!done || refused) return null
          const url = browserString(meta && meta.url)
          const pageTitle = browserClip(browserString(meta && meta.title), 90)
          const headLine = browserHeadLine(browserRendered(meta))
          return [
            url ? h('span', { className: 'msm-tool-sub msm-mono', key: 'url' }, browserClip(url, 160)) : null,
            pageTitle ? h('span', { className: 'msm-tool-sub', key: 'page' }, pageTitle) : null,
            !url && !pageTitle && headLine
              ? h('span', { className: 'msm-tool-sub', key: 'line' }, browserClip(headLine, 160))
              : null,
          ]
        },
      })
    }

    function BrowserSessionToolView({ t, phase, block }) {
      const [expanded, setExpanded] = React.useState(false)
      return h(BrowserCard, {
        t,
        phase,
        block,
        title: t('browserSession'),
        headExtras: (meta, done, refused) => {
          if (!done || refused) return null
          const action = browserString(meta && meta.action)
          const label = action === 'tabs' ? t('browserTabs') : action
          const lines = browserLines(browserRendered(meta))
          const headLine = browserClip(browserHeadLine(lines.join('\n')), 160)
          return [
            label ? h('span', { className: 'msm-tool-chip', key: 'action' }, label) : null,
            headLine ? h('span', { className: 'msm-tool-sub', key: 'line' }, headLine) : null,
            lines.length > 1 ? browserToggle(t, expanded, () => setExpanded((value) => !value)) : null,
          ]
        },
        renderBody: (meta) => {
          const rendered = browserRendered(meta)
          if (!rendered) return null
          const rest = browserLines(rendered).slice(1)
          if (!rest.length) return null
          const shown = expanded ? rest : rest.slice(0, BROWSER_LIST_LINES)
          return h(
            'pre',
            { className: cx('msm-tool-pre', expanded ? 'is-expanded' : null), key: 'rendered' },
            shown.join('\n'),
          )
        },
      })
    }

    // -----------------------------------------------------------------

    /** `hh:mm:ss` for audit timestamps; accepts epoch ms or an ISO string. */
    function browserClockOf(at) {
      let time = Number.NaN
      if (typeof at === 'number') time = at
      else if (typeof at === 'string' && at) time = Date.parse(at)
      if (!Number.isFinite(time)) return typeof at === 'string' && /^\d{2}:\d{2}:\d{2}$/.test(at) ? at : ''
      const date = new Date(time)
      const pad = (value) => String(value).padStart(2, '0')
      return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    }

    /** Compact idle duration: seconds below a minute, whole minutes above. */
    function browserIdleOf(value) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return ''
      if (value < 60000) return `${Math.round(value / 1000)}s`
      return `${Math.round(value / 60000)}m`
    }

    /** One-line summary of `lastAction`: a string as-is, an audit entry as `tool action`. */
    function browserLastActionText(lastAction) {
      if (typeof lastAction === 'string') return lastAction
      if (!lastAction || typeof lastAction !== 'object' || Array.isArray(lastAction)) return ''
      return [browserString(lastAction.tool), browserString(lastAction.action)].filter(Boolean).join(' ')
    }

    /**
     * Defensive view of one `GET api/browser-use/status` value for the Browser
     * tab: instances and `audit.recent` are sanitized field by field, so a
     * missing/older Host half degrades to empty tables instead of bad shapes.
     */
    function normalizeBrowserView(value) {
      const base = normalizeBrowserStatus(value)
      if (!base) return null
      const instances = base.instances.map((instance) => ({
        sessionId: browserString(instance.sessionId),
        url: browserString(instance.url),
        title: browserString(instance.title),
        tabs: typeof instance.tabs === 'number' && Number.isFinite(instance.tabs) ? instance.tabs : null,
        idleMs: typeof instance.idleMs === 'number' && Number.isFinite(instance.idleMs) ? instance.idleMs : null,
        current: instance.current === true,
      }))
      const audit = value.audit && typeof value.audit === 'object' && !Array.isArray(value.audit) ? value.audit : null
      const recent = audit && Array.isArray(audit.recent) ? audit.recent : []
      const entries = recent
        .filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry))
        .slice(0, 20)
        .map((entry) => ({
          at: typeof entry.at === 'number' || typeof entry.at === 'string' ? entry.at : null,
          sessionId: browserString(entry.sessionId),
          tool: browserString(entry.tool),
          action: browserString(entry.action),
          target: browserString(entry.target),
          url: browserString(entry.url),
          ok: entry.ok !== false,
          code: browserString(entry.code),
          risk: browserString(entry.risk),
        }))
        .filter((entry) => entry.at !== null || entry.tool || entry.action || entry.target || entry.code || entry.url)
      return {
        paused: base.paused,
        instances,
        audit: { recent: entries },
        lastAction: browserLastActionText(value.lastAction),
      }
    }

    /**
     * Independent Conversation tab for the browser pool (url/title/tabs/idle),
     * the pause/resume switch and the latest browser audit entries. The status
     * route belongs to dsh-browser-use and can be absent, so a failed poll
     * keeps the last known tables greyed or falls back to readable empty states.
     */
    function BrowserView({ t, sessionId }) {
      const [state, setState] = React.useState({ value: null, stale: false })
      const [busy, setBusy] = React.useState(false)
      const [auditFilter, setAuditFilter] = React.useState('mine')
      const [closing, setClosing] = React.useState('')
      const [closeError, setCloseError] = React.useState('')
      const alive = React.useRef(true)
      const rootRef = React.useRef(null)
      const load = React.useCallback(async () => {
        try {
          const value = normalizeBrowserView(await browserUseStatus(undefined, sessionId))
          if (alive.current) setState({ value, stale: false })
        } catch {
          // Quiet degradation: keep the last tables (greyed) on a transient
          // failure, otherwise stay in the empty states with an offline label.
          if (alive.current) {
            setState((current) => (current.value === null ? { value: null, stale: true } : { value: current.value, stale: true }))
          }
        }
      }, [sessionId])
      React.useEffect(() => {
        alive.current = true
        void load()
        const timer = setInterval(() => void load(), 10000)
        return () => {
          alive.current = false
          clearInterval(timer)
        }
      }, [load])

      // Same shell quirk as the desktop tab: the Conversation shell reuses one
      // scrollport, so start a freshly selected Browser tab at the top.
      React.useEffect(() => {
        const root = rootRef.current
        if (root === null) return undefined
        const reset = () => {
          root.scrollTop = 0
          let node = root.parentElement
          while (node !== null) {
            const style = window.getComputedStyle(node)
            if (/(auto|scroll)/.test(style.overflowY)) node.scrollTop = 0
            node = node.parentElement
          }
        }
        reset()
        const frame = requestAnimationFrame(reset)
        const timer = setTimeout(reset, 120)
        return () => {
          cancelAnimationFrame(frame)
          clearTimeout(timer)
        }
      }, [])

      const value = normalizeBrowserView(state.value)
      const paused = value ? value.paused : false
      const instances = value ? value.instances : []
      const recent = value ? value.audit.recent : []
      const stale = state.stale
      // The Host owns the audit trail; the tab only filters the last 20 entries
      // locally. Entries without a sessionId belong to another/older Session.
      const mineSessionId = typeof sessionId === 'string' ? sessionId : ''
      const visibleAudit =
        auditFilter === 'mine'
          ? recent.filter((entry) => mineSessionId !== '' && entry.sessionId === mineSessionId)
          : recent
      const togglePause = async () => {
        if (busy || stale || !value) return
        setBusy(true)
        try {
          await browserUseStatus({ action: paused ? 'resume' : 'pause' }, sessionId)
        } catch {
          // The follow-up GET is the authoritative answer; never throw here.
        } finally {
          if (alive.current) setBusy(false)
        }
        if (!alive.current) return
        await load()
      }

      // User-side pool maintenance: close one Session's browser, then re-GET.
      // A rejected close is reported inline on that row instead of breaking the
      // tab; the next successful close/reload reconciles the pool.
      const closeInstance = async (instance) => {
        const targetId = instance.sessionId
        if (!targetId || closing !== '' || stale) return
        setClosing(targetId)
        setCloseError('')
        let closed = false
        try {
          await browserUseStatus({ action: 'close', sessionId: targetId }, targetId)
          closed = true
        } catch {
          if (alive.current) setCloseError(targetId)
        } finally {
          if (alive.current) setClosing('')
        }
        if (closed && alive.current) {
          setCloseError('')
          await load()
        }
      }

      const status = value
        ? [
            h(
              'span',
              { className: 'msm-cu-status-item', key: 'state' },
              h('span', { className: 'msm-cu-status-dot', 'data-paused': paused ? 'true' : 'false' }),
              paused ? t('browserPaused') : t('browserRunning'),
            ),
            h('span', { className: 'msm-cu-status-item', key: 'count' }, t('browserInstances', { n: instances.length })),
            value.lastAction
              ? h('span', { className: 'msm-cu-status-item', key: 'last' }, browserClip(value.lastAction, 80))
              : null,
            h(
              Btn,
              { key: 'toggle', variant: 'secondary', disabled: busy || stale, onClick: togglePause },
              paused ? t('browserResume') : t('browserPause'),
            ),
          ]
        : h('span', { className: 'msm-cu-status-item' }, stale ? t('browserStatusOffline') : t('loading'))

      const poolRow = (instance, index) => {
        const label = browserClip(instance.title, 120) || browserClip(instance.url, 120) || t('browserChip')
        const meta = []
        if (instance.tabs !== null) meta.push(`${t('browserTabs')} ${instance.tabs}`)
        const idle = browserIdleOf(instance.idleMs)
        if (idle) meta.push(idle)
        return h(
          'li',
          { key: instance.sessionId || `instance-${index}`, className: 'msm-skill' },
          h(
            'div',
            { className: 'msm-skill-head' },
            h('span', { className: 'msm-skill-name' }, label),
            instance.current ? h('span', { className: 'msm-chip' }, t('browserThisSession')) : null,
            meta.length ? h('span', { className: 'msm-hint' }, meta.join(' · ')) : null,
            h(
              'button',
              {
                type: 'button',
                className: 'msm-btn msm-tool-link',
                title: t('browserClose'),
                disabled: !instance.sessionId || closing !== '' || stale,
                onClick: () => void closeInstance(instance),
              },
              t('browserClose'),
            ),
          ),
          instance.url ? h('span', { className: 'msm-endpoint', title: instance.url }, instance.url) : null,
          closeError !== '' && closeError === instance.sessionId
            ? h('span', { className: 'msm-hint msm-cu-error' }, t('browserCloseFailed'))
            : null,
        )
      }

      const auditRow = (entry, index) => {
        const when = browserClockOf(entry.at)
        const target = browserClip(entry.target, 100)
        return h(
          'li',
          { key: `audit-${index}`, className: 'msm-skill' },
          h(
            'div',
            { className: 'msm-skill-head' },
            when ? h('span', { className: 'msm-mono msm-cu-op-time' }, when) : null,
            entry.tool ? h('span', { className: 'msm-tool-title' }, entry.tool) : null,
            entry.action ? h('span', { className: 'msm-tool-chip' }, entry.action) : null,
            target ? h('span', { className: 'msm-tool-sub' }, target) : null,
            entry.ok
              ? h('span', { className: 'msm-badge', 'data-on': 'true' }, 'ok')
              : h('span', { className: 'msm-tool-code', title: entry.code || '' }, entry.code || 'error'),
            entry.risk ? h('span', { className: 'msm-badge' }, entry.risk) : null,
          ),
          entry.url ? h('span', { className: 'msm-endpoint', title: entry.url }, entry.url) : null,
        )
      }

      const emptyState = (key, text) =>
        h('div', { className: 'msm-empty', key }, h('p', { className: 'msm-empty-title' }, text))

      const auditFilters = [
        ['mine', t('browserAuditMine')],
        ['all', t('browserAuditAll')],
      ]

      return h(
        'div',
        { className: 'msm-cu', ref: rootRef },
        h(
          'div',
          { className: 'msm-cu-inner' },
          h(
            'div',
            { className: 'msm-cu-head' },
            h(
              'div',
              { className: 'msm-cu-heading' },
              h('h2', { className: 'msm-cu-title' }, t('browserView')),
              h(
                'div',
                {
                  className: 'msm-cu-status',
                  'data-stale': stale ? 'true' : undefined,
                  title: stale ? t('browserStatusOffline') : undefined,
                },
                status,
              ),
            ),
          ),
          h(BrowserCapabilityBar, { t, sessionId }),
          h(
            'section',
            { className: 'msm-stack' },
            h('div', { className: 'msm-section-head' }, h('h3', { className: 'msm-section-title' }, t('browserPool'))),
            instances.length
              ? h('ul', { className: 'msm-skill-list' }, instances.map(poolRow))
              : emptyState('pool-empty', t('browserNoInstances')),
          ),
          h(
            'section',
            { className: 'msm-stack' },
            h(
              'div',
              { className: 'msm-section-head' },
              h('h3', { className: 'msm-section-title' }, t('browserAudit')),
              h(
                'div',
                { className: 'msm-cu-filters', role: 'group', 'aria-label': t('browserAudit') },
                auditFilters.map(([filterValue, label]) =>
                  h(
                    'button',
                    {
                      key: filterValue,
                      type: 'button',
                      className: 'msm-cu-filter',
                      'aria-pressed': auditFilter === filterValue ? 'true' : 'false',
                      onClick: () => setAuditFilter(filterValue),
                    },
                    label,
                  ),
                ),
              ),
            ),
            recent.length === 0
              ? emptyState('audit-empty', t('browserNoAudit'))
              : visibleAudit.length === 0
                ? emptyState('audit-nomatch', t('noAuditMatch'))
                : h('ul', { className: 'msm-skill-list' }, visibleAudit.map(auditRow)),
          ),
        ),
      )
    }

    // -----------------------------------------------------------------
    // Registration
    // -----------------------------------------------------------------

    return {
      name: 'browser-use',
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'browser-use: dictionaries')
        ctx.effect(() => {
          const tag = document.createElement('style')
          tag.dataset.plugin = 'dsh-browser-use'
          tag.dataset.pluginCss = 'dsh-browser-use/client.css'
          tag.textContent = CSS
          document.head.appendChild(tag)
          return () => tag.remove()
        }, 'browser-use: panel styles')

        const t = ctx.locale.bind(NS)

        // One lightweight card per browser tool, driven only by the
        // presentationMeta the Host half supplies.
        ctx.slots.inject('tool.call.toolview', function* () {
          yield ctx.slots.register({ name: 'tool.call.toolview', key: 'browser_open', locale: NS }, BrowserOpenToolView)
          yield ctx.slots.register({ name: 'tool.call.toolview', key: 'browser_observe', locale: NS }, BrowserObserveToolView)
          yield ctx.slots.register({ name: 'tool.call.toolview', key: 'browser_act', locale: NS }, BrowserActToolView)
          yield ctx.slots.register({ name: 'tool.call.toolview', key: 'browser_read', locale: NS }, BrowserReadToolView)
          yield ctx.slots.register({ name: 'tool.call.toolview', key: 'browser_session', locale: NS }, BrowserSessionToolView)
          yield ctx.slots.register({ name: 'tool.call.toolview', key: 'browser_evidence', locale: NS }, BrowserEvidenceToolView)
        })

        // The 浏览器 tab beside the shipped Chat and Trajectory views. The
        // status route highlights the instance owned by this Session when the
        // query carries its id, which drives the 本会话 chip.
        ctx.slots.inject('conversation.view', function* () {
          yield ctx.slots.register(
            {
              name: 'conversation.view',
              id: 'browser-use',
              order: 21,
              locale: NS,
              label: () => t('browserView'),
              inject: (sessionId) => ({ sessionId }),
            },
            BrowserView,
          )
        })

        // The compact chip only appears while a browser is open or browser
        // actions are paused, and carries the pause/resume button.
        ctx.slots.inject('conversation.input.left', function* () {
          yield ctx.slots.register(
            {
              name: 'conversation.input.left',
              id: 'browser-status',
              order: 41,
              locale: NS,
            },
            BrowserStatus,
          )
        })
      },
    }
  },
})
