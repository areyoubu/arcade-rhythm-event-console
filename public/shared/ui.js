/**
 * 通用 UI 组件 —— 全控制端页面共用。
 * A-REQ-705：所有操作须有 ≤100ms 的视觉反馈 → toast / 按钮 busy 态都走这里。
 */
(function () {
  'use strict';

  const esc = window.fmt.escapeHtml;

  // ── 元素创建 ─────────────────────────────────────────────
  function el(tag, attrs, ...children) {
    const n = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') n.className = v;
        else if (k === 'style' && typeof v === 'object') Object.assign(n.style, v);
        else if (k === 'dataset') Object.assign(n.dataset, v);
        else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2).toLowerCase(), v);
        else if (k === 'html') n.innerHTML = v;
        else if (k === 'text') n.textContent = v;
        else n.setAttribute(k, v === true ? '' : v);
      }
    }
    for (const c of children.flat()) {
      if (c === null || c === undefined || c === false) continue;
      n.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return n;
  }

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  function clear(node) { while (node && node.firstChild) node.removeChild(node.firstChild); return node; }

  // ── Toast ────────────────────────────────────────────────
  let toastHost = null;
  function toast(msg, { type = 'info', title = null, ms = 3600 } = {}) {
    if (!toastHost) {
      toastHost = el('div', { class: 'toasts' });
      document.body.append(toastHost);
    }
    const node = el('div', { class: `toast ${type}` },
      title ? el('div', { class: 'toast-title', text: title }) : null,
      el('div', { class: 'toast-msg', text: msg }),
    );
    toastHost.append(node);
    setTimeout(() => {
      node.style.transition = 'opacity .2s, transform .2s';
      node.style.opacity = '0';
      node.style.transform = 'translateY(6px)';
      setTimeout(() => node.remove(), 220);
    }, ms);
    return node;
  }
  const ok = (m, o) => toast(m, { type: 'ok', ...o });
  const warn = (m, o) => toast(m, { type: 'warn', ...o });
  const err = (m, o) => toast(m, { type: 'err', ...o });

  /** 统一处理 cmd() 的失败（B-REQ-5110：必须把 nack 的 code/msg 明确呈现给操作员） */
  function cmdError(e, context = '') {
    const code = e?.code || 'error';
    const friendly = {
      preflight_failed: '预检未通过',
      busy: '有操作正在执行中，请稍候',
      bad_phase: '当前状态不允许该操作',
      confirm_required: '需要二次确认',
      timeout: '服务端无响应',
      offline: '未连接到服务端',
      unknown_op: '服务端未实现该命令',
      forbidden: '当前受众无权限',
      obs_disconnected: 'OBS 未连接',
      needs_channel: '该函数必须先选通道',
      invalid_function: '函数名无效',
      feature_disabled: '功能未启用（设置 → 功能开关）',
    }[code];
    err(`${context ? context + '：' : ''}${friendly || e.message}`, { title: friendly ? `错误 ${code}` : '操作失败', ms: 5200 });
    console.warn('[cmd error]', context, code, e.message, e);
  }

  // ── Modal ────────────────────────────────────────────────
  function modal({ title, body, footer, wide = false, onClose = null }) {
    const back = el('div', { class: 'modal-back' });
    const box = el('div', { class: `modal${wide ? ' wide' : ''}` });
    const close = () => { back.remove(); document.removeEventListener('keydown', onKey); onClose && onClose(); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);

    box.append(el('header', null,
      el('span', { text: title }),
      el('span', { class: 'spacer' }),
      el('button', { class: 'btn ghost sm', text: '✕', onclick: close }),
    ));
    const bodyEl = el('div', { class: 'body' });
    if (typeof body === 'string') bodyEl.innerHTML = body; else if (body) bodyEl.append(body);
    box.append(bodyEl);
    if (footer) box.append(el('footer', null, footer));

    back.append(box);
    back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
    document.body.append(back);
    return { close, box, body: bodyEl };
  }

  /** 二次确认 —— B-REQ-2009 删除类 / B-REQ-2008 高危操作必须走这里 */
  function confirm({ title = '确认操作', message, detail = null, danger = false, confirmText = '确认', requireText = null }) {
    return new Promise((resolve) => {
      let answer = false;
      const input = requireText
        ? el('input', { type: 'text', placeholder: `请输入 ${requireText} 以确认` })
        : null;
      const m = modal({
        title,
        body: el('div', null,
          el('p', { text: message }),
          detail ? el('div', { class: `note ${danger ? 'danger' : 'warn'}`, html: detail }) : null,
          input ? el('div', { class: 'field mt12' }, el('label', { text: '二次确认' }), input) : null,
        ),
        footer: [
          el('button', { class: 'btn ghost', text: '取消', onclick: () => { answer = false; m.close(); resolve(false); } }),
          el('button', {
            class: `btn ${danger ? 'danger' : 'primary'}`,
            text: confirmText,
            onclick: () => {
              if (input && input.value.trim() !== requireText) { warn(`请输入「${requireText}」以确认`); return; }
              answer = true; m.close(); resolve(true);
            },
          }),
        ],
        onClose: () => { if (!answer) resolve(false); },
      });
      if (input) setTimeout(() => input.focus(), 40);
    });
  }

  /**
   * 单行/多行文本输入。
   *
   * ⚠️ 这里必须用 settled 闸门：`m.close()` 会**同步**触发 `onClose`，
   * 若先 close 再 resolve，`onClose` 里的 `resolve(null)` 会抢先兑现 Promise，
   * 于是点「确定」也永远拿到 null —— 表现就是「点试发 → 填了变量 → 什么都没发生」。
   */
  function prompt({ title = '输入', label = '', value = '', placeholder = '', multiline = false, password = false }) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (v) => {
        if (settled) return;
        settled = true;
        m.close();
        resolve(v);
      };
      const input = multiline
        ? el('textarea', { placeholder })
        : el('input', { type: password ? 'password' : 'text', placeholder, autocomplete: password ? 'current-password' : 'off' });
      input.value = value;
      const m = modal({
        title,
        body: el('div', null, label ? el('div', { class: 'field' }, el('label', { text: label }), input) : input),
        footer: [
          el('button', { class: 'btn ghost', text: '取消', onclick: () => finish(null) }),
          el('button', { class: 'btn primary', text: '确定', onclick: () => finish(input.value) }),
        ],
        onClose: () => finish(null),
      });
      setTimeout(() => input.focus(), 40);
      if (!multiline) input.addEventListener('keydown', (e) => { if (e.key === 'Enter') finish(input.value); });
    });
  }

  /**
   * 选手选择弹窗 —— 比分条 / 比赛计分共用。
   *
   * 之前的两个页面各抄了一份几乎一样的搜索列表；这里收成一处：
   *   · 按姓名 / 队伍 / handle 过滤
   *   · 头像加载失败时显示首字占位
   *   · 可以清空该侧（onPick(null)）
   *   · selectedId 会标「当前」
   *
   * @param {object} opts
   * @param {string} [opts.title]
   * @param {Array} [opts.players]
   * @param {Array} [opts.teams]
   * @param {string|null} [opts.selectedId]
   * @param {(id:string|null)=>void} [opts.onPick]
   * @param {string} [opts.emptyText]
   */
  function playerPicker({
    title = '选择选手',
    players = [],
    teams = [],
    selectedId = null,
    onPick = () => {},
    emptyText = '还没有选手，请先到「人物」页添加',
  } = {}) {
    const search = el('input', { type: 'search', placeholder: '搜索选手 / 队伍…' });
    const list = el('div', { class: 'player-pick-list' });
    let m = null;

    const teamNameOf = (p) => {
      const t = (teams || []).find((x) => x.id === p.teamId);
      return t?.name || p.team || '';
    };
    const choose = (id) => {
      if (m) m.close();
      onPick(id || null);
    };

    function renderList() {
      clear(list);
      const q = String(search.value || '').trim().toLowerCase();
      const items = (players || []).filter((p) => !q
        || `${p.name || ''} ${teamNameOf(p)} ${p.handle || ''}`.toLowerCase().includes(q));
      if (!items.length) {
        list.append(el('div', {
          class: 'dim small', style: { padding: '12px' },
          text: players.length ? '没有匹配的选手' : emptyText,
        }));
        return;
      }
      for (const p of items) {
        list.append(el('button', {
          class: 'player-pick-row', type: 'button', onclick: () => choose(p.id),
        },
          p.image
            ? el('img', { class: 'pp-avatar', src: p.image, alt: '', loading: 'lazy' })
            : el('span', { class: 'pp-avatar pp-fb', text: (p.name || '?').slice(0, 1) }),
          el('span', { class: 'pp-main' },
            el('span', { class: 'pp-name truncate', text: p.name || '（未命名）' }),
            el('span', { class: 'pp-team truncate', text: teamNameOf(p) || '无队伍' }),
          ),
          p.id === selectedId ? el('span', { class: 'pp-current', text: '当前' }) : null,
        ));
      }
    }

    search.oninput = renderList;
    m = modal({
      title,
      body: el('div', null, search, list),
      footer: [
        el('button', { class: 'btn ghost', text: '清空该侧', onclick: () => choose(null) }),
        el('button', { class: 'btn', text: '取消', onclick: () => m.close() }),
      ],
    });
    renderList();
    setTimeout(() => search.focus(), 40);
    return m;
  }

  // ── 系统功能目录 ─────────────────────────────────────────
  /**
   * 顶栏 / 首页 / 输出页共用同一份目录。
   *
   * item 字段：
   *   href, label（顶栏短名）, title, desc, badge（模块/A-F/共享）
   *   feature     功能开关名（未开启时顶栏隐藏、首页标灰）
   *   kind        'page'（默认控制页）| 'render'（OBS 源）| 'public'（手机页）
   *   nav:false   不放进顶栏（渲染源 / 手机页）
   *   target      渲染端 WS target，用于输出页显示连接状态
   *   size/layer  输出页展示的推荐尺寸 / 透明叠加或整屏
   *   open        'window' | 'preview'（输出页的打开方式）
   *   previewHref 预览地址
   *   qr          'lottery' | 'match'（公共页的二维码接口）
   */
  const CATALOG = [
    {
      id: 'live', label: '直播图形', desc: '叠加、模板、媒体、人物与致谢',
      items: [
        { href: '/overlay', label: '叠加', title: '叠加主控制台', desc: '模板选择 · 实体填充 · 槽位热改 · 预览 / 输出分离 · 队列与撤销', badge: 'A' },
        { href: '/templates', label: '模板', title: '模板管理', desc: '槽位编辑 · schema 校验 · 热重载实时预览', badge: 'A' },
        { href: '/media', label: '媒体', title: '媒体库', desc: '上传 / 缩略图 / 引用检查 / 目录直投自动索引', badge: 'A' },
        { href: '/people', label: '人物', title: '人物与角色', desc: '队伍 / 选手 / 解说·导播 / 赞助商统一管理，选手按队伍分组', badge: 'A' },
        { href: '/credits', label: '致谢', title: '感谢列表', desc: '滚动 / 网格 · 拖拽排序 · 按标签导入 · 时长预估', badge: 'A' },
        {
          id: 'render-main', kind: 'render', href: '/render/main', label: '主叠加源', title: '主叠加（浮窗-主）',
          desc: '透明浏览器源：姓名条 / 对阵卡 / 双人名牌等叠加模板', target: 'main',
          badge: 'A', nav: false, size: '1920×1080', layer: '透明叠加',
          open: 'preview', previewHref: '/render/main?preview=1&guides=1',
        },
        {
          id: 'render-credits', kind: 'render', href: '/render/credits', label: '致谢源', title: '致谢（浮窗-致谢）',
          desc: '透明浏览器源：滚动 / 网格致谢', target: 'credits',
          badge: 'A', nav: false, size: '1920×1080', layer: '透明叠加',
          open: 'preview', previewHref: '/render/credits?preview=1',
        },
      ],
    },
    {
      id: 'match', label: '比赛', desc: '计分、比分条与比赛画面',
      items: [
        { href: '/match', label: '比赛', title: '比赛计分', desc: '1–4 首自适应 · 总分 / 小局制 · 曲目与难度 · Ban · 扫码选曲 · 历史', badge: 'F' },
        { href: '/random', label: '随机选曲', title: '随机选曲大屏', desc: '全屏滚动随机 · 缓停后放大曲绘与曲目信息 · 可应用到比赛', badge: 'F' },
        { href: '/pickshow', label: '选曲展示', title: '选手选曲展示', desc: '手机选歌器 → 选曲队列 · P1/P2/同时 · 每人 2 首或 4 首', badge: 'F' },
        {
          id: 'render-pickshow', kind: 'render', href: '/render/pickshow', label: '选曲大屏', title: '选手选曲展示（/render/pickshow）',
          desc: '整屏场景：展示 P1 / P2 / 同时的选曲，支持 2 首 / 4 首布局',
          target: 'pickshow', badge: 'F', nav: false, size: '1920×1080', layer: '整屏场景',
          open: 'preview', previewHref: '/render/pickshow?preview=1&fit=1',
        },
        {
          id: 'render-random', kind: 'render', href: '/render/random', label: '随机大屏', title: '随机选曲大屏（/render/random）',
          desc: '整屏场景：右向左滚动抽选，抽中后放大曲绘与详情；动态 / 静态背景可选',
          target: 'random', badge: 'F', nav: false, size: '1920×1080', layer: '整屏场景',
          open: 'preview', previewHref: '/render/random?preview=1&fit=1',
        },
        { href: '/music', label: '曲目库', title: '曲目库管理', desc: '曲目增改删 · 难度定数 · 国服标记 · 上传 xlsx 全量更新', badge: 'F' },
        { href: '/scoreboard', label: '比分', title: '比分条', desc: '常驻比分 + P1/P2 选手牌 · 加一减一暂存确认 · 布局与分件输出', badge: 'D' },
        {
          id: 'render-match', kind: 'render', href: '/render/match', label: '总比分', title: '总比分画面',
          desc: '独立整屏场景 · 复用直播间动态背景 · 每首曲目 / 双方成绩 / 胜负',
          target: 'match', badge: 'F', nav: false, size: '1920×1080', layer: '整屏场景', open: 'window',
        },
        {
          id: 'render-score', kind: 'render', href: '/render/score', label: '比分条源', title: '比分条 / 选手牌',
          desc: '比分条 + 两块选手牌常驻叠加；也可以拆成三路分件', target: 'score',
          badge: 'D', nav: false, size: '1920×1080', layer: '透明叠加', open: 'window',
        },
        {
          id: 'render-pick', kind: 'render', href: '/render/pick', label: '选曲二维码', title: '选曲二维码大屏',
          desc: '扫码选曲二维码 + 最近提交的选曲', target: 'matchpick',
          badge: 'F', nav: false, size: '1920×1080', layer: '透明叠加', open: 'window',
        },
        {
          id: 'public-pick', kind: 'public', href: '/pick', label: '扫码选曲', title: '手机扫码选曲',
          desc: '选手选择 P1/P2、曲目与难度，提交后由导播确认', qr: 'match',
          badge: '公共', nav: false,
        },
      ],
    },
    {
      id: 'interactive', label: '互动', desc: '抽奖、签到与现场互动',
      items: [
        { href: '/lottery', label: '抽奖', title: '抽奖控制台', desc: '抽奖池筛选 · 大屏动画 · 中奖记录 · 现场签到二维码', badge: 'E' },
        { href: '/guests', label: '签到', title: '签到管理', desc: '现场签到名单 · 添加 / 编辑 / 删除 · 导入 CSV · 导出 / 二维码', badge: 'E' },
        {
          id: 'render-lottery', kind: 'render', href: '/render/lottery', label: '抽奖大屏', title: '抽奖大屏',
          desc: '滚动名字 / 中奖卡 / 彩带', target: 'lottery',
          badge: 'E', nav: false, size: '1920×1080', layer: '透明叠加', open: 'window',
        },
        {
          id: 'render-prize', kind: 'render', href: '/render/prize', label: '奖品大屏', title: '奖品展示画面',
          desc: '本轮奖品图片 + 大号名称 · 自适应任意图片比例 · 复用直播间动态背景',
          target: 'lottery', badge: 'E', nav: false, size: '1920×1080', layer: '整屏场景', open: 'window',
        },
        {
          id: 'public-join', kind: 'public', href: '/join', label: '签到页', title: '现场签到',
          desc: '手机扫码填写姓名加入抽奖池', qr: 'lottery',
          badge: '公共', nav: false,
        },
      ],
    },
    {
      id: 'playout', label: '播控', desc: '导播、解说、提示、回放与转场',
      items: [
        { href: '/director', label: '导播', title: '导播页', desc: '编排倒计时 · 回执看板 · 转场大提醒', badge: 'C' },
        { href: '/commentary', label: '解说', title: '解说控制台', desc: '解说提示叠加 + 解说摄像头叠加 · 两路预览与配置', badge: 'C' },
        {
          id: 'cast-source', kind: 'render', href: '/cast', label: '提示源', title: '解说提示叠加（/cast）',
          desc: '透明 OBS 浏览器源：提示收进「提示预览」区域，并可显示比赛 / 比分 / 当前曲目', target: 'cast',
          badge: 'C', nav: false, size: '1920×1080', layer: '透明叠加',
          open: 'preview', previewHref: '/cast?preview=1&config=1',
        },
        {
          id: 'cast-cam-source', kind: 'render', href: '/render/castcam', label: '摄像头源', title: '解说摄像头叠加（/render/castcam）',
          desc: '透明 OBS 浏览器源：摄像头边框 / 解说标签 / LIVE / 姓名牌，中心留空给摄像头画面',
          target: 'castcam', badge: 'C', nav: false, size: '1920×1080', layer: '透明叠加',
          open: 'preview', previewHref: '/render/castcam?preview=1&fit=1',
        },
        { href: '/cues', label: '话术', title: '话术模板', desc: '内置话术 · 变量插值 · 自定义', badge: 'C' },
        { href: '/replay', label: '回放', title: '回放控制器', desc: '13 个功能区 / 151 个 vMix 函数', badge: 'B', feature: 'replay' },
        { href: '/transitions', label: '转场', title: 'OBS 转场', desc: '转场切换 · 场景覆盖 · 防穿帮方案', badge: 'B', feature: 'transitions' },
      ],
    },
    {
      id: 'system', label: '系统', desc: '输出地址、日志与设置',
      items: [
        { href: '/outputs', label: '输出', title: '输出与场景', desc: '全部 OBS 浏览器源 · 公共扫码入口 · 连接状态 · 背景素材', badge: '共享' },
        { href: '/logs', label: '日志', title: '日志与历史', desc: 'JSONL 检索 · 提示历史', badge: '共享' },
        { href: '/settings', label: '设置', title: '设置', desc: 'OBS / vMix / 比赛 / 抽奖 / 提示与数据', badge: '共享' },
      ],
    },
  ];

  const NAV_GROUPS = CATALOG
    .map((g) => ({ ...g, items: g.items.filter((i) => i.nav !== false) }))
    .filter((g) => g.items.length);
  const NAV = [
    { href: '/', label: '首页', title: '系统总览' },
    ...NAV_GROUPS.flatMap((g) => g.items),
  ];

  /** 功能开关是否已启用（前端以服务端下发的 config.features 为准） */
  function featureEnabled(name) {
    const f = window.arcadeWS?.state?.config?.features;
    return !!(f && f[name] === true);
  }

  /**
   * 未启用功能的页面闸门：返回一块提示卡片，按 config.features 自动显隐。
   * 页面把它插到最上面即可；真正的拦截在服务端（HTTP 403 / WS feature_disabled）。
   *
   * requires 用于表达依赖：转场依赖 OBS、回放依赖 vMix。
   */
  function featureBanner(name, label, { requires = null, requiresLabel = '' } = {}) {
    const text = el('span');
    const box = el('div', { class: 'note warn mb16', style: { display: 'none' } },
      text,
      ' 本页的操作会被服务端拒绝。请到 ',
      el('a', { href: '/settings#features', text: '设置 → 功能开关' }),
      ' 开启后即可使用（无需重启）。',
    );
    const sync = () => {
      const off = !featureEnabled(name);
      const depOff = requires && !featureEnabled(requires);
      box.style.display = (!off && !depOff) ? 'none' : '';
      clear(text);
      if (depOff) text.append(el('strong', { text: `「${label}」需要先启用「${requiresLabel}」` }));
      else text.append(el('strong', { text: `「${label}」未启用` }));
    };
    box.__sync = sync;
    window.arcadeWS?.on('hello', sync);
    window.arcadeWS?.on('patch', (m) => {
      if (m.path === 'config.features' || String(m.path || '').startsWith('config.features.')) sync();
    });
    setTimeout(sync, 0);
    return box;
  }

  function topbar({ current = '', extra = null } = {}) {
    const linkOf = (n, groupLabel = '') => el('a', {
      href: n.href,
      class: (n.href === current || (current !== '/' && n.href !== '/' && current.startsWith(n.href))) ? 'active' : '',
      dataset: n.feature ? { feature: n.feature } : null,
      title: groupLabel ? `${groupLabel} · ${n.title || n.label}` : (n.title || n.label),
      text: n.label,
    });
    const navChildren = [linkOf({ href: '/', label: '首页', title: '系统总览' })];
    for (const g of NAV_GROUPS) {
      navChildren.push(el('span', { class: 'nav-sep', 'aria-hidden': 'true' }));
      for (const n of g.items) navChildren.push(linkOf(n, g.label));
    }
    const nav = el('nav', null, navChildren);
    // 功能未启用的入口直接隐藏 —— 避免操作员点进去看到一个什么都做不了的页面
    const applyFeatureNav = () => {
      for (const a of nav.querySelectorAll('[data-feature]')) {
        a.hidden = !featureEnabled(a.dataset.feature);
      }
    };
    window.arcadeWS?.on('hello', applyFeatureNav);
    window.arcadeWS?.on('patch', (m) => {
      if (m.path === 'config.features' || String(m.path || '').startsWith('config.features.')) applyFeatureNav();
    });
    applyFeatureNav();
    const bar = el('div', { class: 'topbar' },
      el('div', { class: 'brand' }, el('span', { class: 'dot' }), el('span', { text: '街机音游赛事控制软件' })),
      nav,
      el('span', { class: 'spacer' }),
      extra,
      connPill(),
    );
    return bar;
  }

  function connPill() {
    const pill = el('span', { class: 'pill mute' }, el('span', { class: 'dot-led' }), el('span', { text: '连接中…' }));
    const led = $('.dot-led', pill);
    const txt = $('span:last-child', pill);
    const sync = () => {
      const on = window.arcadeWS?.connected;
      led.className = `dot-led ${on ? 'ok' : 'err'}`;
      pill.className = `pill ${on ? 'ok' : 'err'}`;
      txt.textContent = on ? '已连接' : '已断开';
    };
    window.arcadeWS?.on('open', sync);
    window.arcadeWS?.on('close', sync);
    window.arcadeWS?.on('reconnecting', () => { txt.textContent = '重连中…'; });
    setTimeout(sync, 60);
    return pill;
  }

  /** 页面骨架：顶栏 + 内容容器 */
  function mount({ current, title, subtitle, extra = null }) {
    const bar = topbar({ current, extra });
    const page = el('div', { class: 'page wide' });
    if (title) {
      page.append(el('div', { class: 'flex items-center justify-between mb16' },
        el('div', null,
          el('h1', { class: 'mb0', text: title }),
          subtitle ? el('div', { class: 'muted small', text: subtitle }) : null,
        ),
      ));
    }
    const app = el('div', { class: 'app' }, bar, page);
    document.body.append(app);
    // 所有控制页共用一条 WS。页面若稍后调用 start({audience})，ws.js 会补发身份。
    window.arcadeWS?.start?.({});
    return page;
  }

  // ── 状态条 ───────────────────────────────────────────────
  /** 链路状态条：vMix / OBS / 渲染端 / 监看，全站复用同一套口径 */
  function linkStatusBar() {
    const bar = el('div', { class: 'statusbar' });
    const items = {
      vmix: pill('vMix'),
      obs: pill('OBS'),
      render: pill('渲染端'),
      cast: pill('解说端'),
      phase: pill('相位'),
    };
    bar.append(items.vmix, items.obs, items.render, items.cast, el('span', { class: 'spacer' }), items.phase);

    const sync = () => {
      const s = window.arcadeWS?.state || {};
      const h = s.health || {};
      set(items.vmix, !!h.vmix?.connected,
        h.vmix?.connected ? `vMix ${h.vmix.rttMs ?? 0}ms` : (h.vmix?.lastErr ? `vMix 断开` : 'vMix 未连接'),
        h.vmix?.lastErr);
      set(items.obs, !!h.obs?.connected, h.obs?.connected ? 'OBS 已连接' : 'OBS 未连接', h.obs?.lastErr);
      const rc = h.overlayClients ?? 0;
      set(items.render, rc > 0, `渲染端 ${rc}`, rc === 0 ? 'OBS 浏览器源未连接：请确认 /render/main 已加载' : null);
      // 监看已改为「页面作为 OBS 浏览器源 + NDI/HDMI 输出」，这里改为核验解说端是否已接入
      const castN = s.cue?.counts?.cast ?? 0;
      const dirN = s.cue?.counts?.director ?? 0;
      set(items.cast, castN > 0, `解说端 ${castN}`,
        castN === 0 ? '解说端页面尚未接入（把 /cast 作为 OBS 浏览器源加入场景即可）' : `导播端 ${dirN} 个已接入`);
      const ph = s.replay?.phase || 'IDLE';
      const phPill = items.phase;
      phPill.className = `pill ${ph === 'FAULT' ? 'err' : ph === 'AIR' ? 'warn' : ph === 'IDLE' ? 'mute' : 'info'}`;
      phPill.textContent = `相位 ${window.fmt.phaseLabel(ph)}`;
    };
    window.arcadeWS?.on('hello', sync);
    window.arcadeWS?.on('patch', sync);
    setInterval(sync, 1500);
    setTimeout(sync, 80);
    return bar;

    function pill(name) { return el('span', { class: 'pill mute' }, `● ${name}`); }
    function set(p, good, text, title) {
      p.className = `pill ${good ? 'ok' : 'err'}`;
      p.textContent = `● ${text}`;
      p.title = title || '';
    }
  }

  // ── 按钮忙碌态 ───────────────────────────────────────────
  /** 包一层：按钮点击 → 禁用 + 转圈 → 完成后恢复（A-REQ-705） */
  async function withBusy(btn, fn) {
    if (!btn || btn.disabled) return;

    /**
     * ⚠️ 只有 <button> 才能用 spinner 替换内容。
     * <select> / <input> 的 innerHTML 就是**数据本身**：替换成 spinner 会清空所有
     * <option>，再“恢复”时写回去的是 textContent，于是下拉框永远变空、
     * 选中的值也读不到（表现：比分条里选不了选手/队伍）。这类控件只做禁用。
     */
    if (btn.tagName !== 'BUTTON') {
      btn.disabled = true;
      try { return await fn(); } finally { btn.disabled = false; }
    }

    const old = btn.dataset.label || btn.textContent;
    btn.dataset.label = old;
    btn.disabled = true;
    btn.dataset.busy = '1';
    btn.innerHTML = '<span class="spinner" style="width:12px;height:12px;border-width:2px"></span>';
    try { return await fn(); } finally {
      btn.disabled = false;
      btn.innerHTML = old;
      delete btn.dataset.busy;
    }
  }

  /** 拖拽排序（A-REQ-730 致谢拖拽 / 媒体多选排序） */
  function sortable(container, { handle = '[draggable], .drag', onEnd = null, selector = '[data-id]' } = {}) {
    let dragEl = null;
    container.addEventListener('dragstart', (e) => {
      const t = e.target.closest(selector);
      if (!t || !container.contains(t)) return;
      dragEl = t;
      t.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', t.dataset.id || ''); } catch { /* ignore */ }
    });
    container.addEventListener('dragend', () => {
      if (dragEl) dragEl.classList.remove('dragging');
      dragEl = null;
      if (onEnd) onEnd([...container.querySelectorAll(selector)].map((n) => n.dataset.id));
    });
    container.addEventListener('dragover', (e) => {
      if (!dragEl) return;
      e.preventDefault();
      const after = afterElement(container, e.clientX, e.clientY, selector);
      if (after == null) container.appendChild(dragEl);
      else container.insertBefore(dragEl, after);
    });
    function afterElement(c, x, y, sel) {
      const els = [...c.querySelectorAll(`${sel}:not(.dragging)`)];
      let best = null;
      let bestDist = Infinity;
      for (const e of els) {
        const box = e.getBoundingClientRect();
        const cx = box.left + box.width / 2;
        const cy = box.top + box.height / 2;
        const d = Math.hypot(x - cx, y - cy);
        if (d < bestDist) { bestDist = d; best = e; }
      }
      if (!best) return null;
      const box = best.getBoundingClientRect();
      return (x > box.left + box.width / 2) ? best.nextElementSibling : best;
    }
  }

  // ── 数据轮询兜底 ─────────────────────────────────────────
  /** WS 断了也能看数据的兜底：定时拉 HTTP（A-REQ-537 的失败静默原则在控制端不适用） */
  function poll(fn, ms = 3000) {
    let timer = null;
    let stopped = false;
    const run = async () => {
      if (stopped) return;
      try { await fn(); } catch (e) { console.warn('[poll] 失败', e.message); }
      if (!stopped) timer = setTimeout(run, ms);
    };
    run();
    return () => { stopped = true; clearTimeout(timer); };
  }

  // ── 管理令牌 ────────────────────────────────────────────
  const ADMIN_TOKEN_KEY = 'lp_admin_token';
  function adminToken() {
    try { return localStorage.getItem(ADMIN_TOKEN_KEY) || ''; } catch { return ''; }
  }
  function setAdminToken(v) {
    try { v ? localStorage.setItem(ADMIN_TOKEN_KEY, v) : localStorage.removeItem(ADMIN_TOKEN_KEY); } catch { /* ignore */ }
    // WS 控制命令也要这份密码：重新发一次 client:hello（带新 token）
    try { window.arcadeWS?.start?.({}); } catch { /* ignore */ }
  }
  /** 请求头：带管理令牌（若已输入） */
  function authHeaders(extra = {}) {
    const t = adminToken();
    return t ? { Authorization: `Bearer ${t}`, ...extra } : extra;
  }

  // 防止多个并行 401 同时弹出多个登录框：共享一个进行中的弹框
  let adminPrompting = null;
  /** 登录框：输入一次后台密码，存 localStorage（后续请求自动带上） */
  function ensureAdminToken() {
    if (adminPrompting) return adminPrompting;
    adminPrompting = prompt({
      title: '后台登录',
      label: '需要登录密码才能访问控制台（内网可打开 /admin-setup 修改密码）',
      placeholder: '输入后台登录密码',
      password: true,
    }).then((t) => {
      if (!t) return false;
      setAdminToken(t.trim());
      return true;
    }).finally(() => { adminPrompting = null; });
    return adminPrompting;
  }

  /** 受控的 fetch 包装：统一错误提示 + 管理令牌 + 401 自动提示登录 */
  async function api(path, { method = 'GET', body = null, quiet = false, retried = false } = {}) {
    let res;
    try {
      res = await fetch(path, {
        method,
        headers: body ? authHeaders({ 'Content-Type': 'application/json' }) : authHeaders(),
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      const e = new Error('网络请求失败');
      e.status = 0;
      throw e;
    }

    let data = null;
    try { data = await res.json(); } catch { /* 可能是空响应 */ }

    // 401 且是「未授权」：提示输入令牌后重试一次
    if (res.status === 401 && !retried && data?.nack?.code === 'unauthorized') {
      const ok = await ensureAdminToken();
      if (ok) return api(path, { method, body, quiet, retried: true });
    }

    if (!res.ok || (data && data.ok === false)) {
      const message = (data && (data.errors ? Object.values(data.errors)[0] : data.nack?.msg || data.msg)) || `HTTP ${res.status}`;
      const e = new Error(message);
      e.status = res.status;
      e.data = data;
      if (!quiet) err(message, { title: '请求失败' });
      throw e;
    }
    return data;
  }

  /** 上传 / FormData 用的 fetch：带管理令牌 */
  async function uploadFetch(path, fd) {
    let res = await fetch(path, { method: 'POST', headers: authHeaders(), body: fd });
    let data = null;
    try { data = await res.json(); } catch { /* ignore */ }
    if (res.status === 401 && data?.nack?.code === 'unauthorized') {
      const ok = await ensureAdminToken();
      if (ok) {
        res = await fetch(path, { method: 'POST', headers: authHeaders(), body: fd });
        try { data = await res.json(); } catch { /* ignore */ }
      }
    }
    return { res, data };
  }

  /**
   * 从媒体库选择图片（单张 / 多张）。
   *
   * 用于比赛 Logo、轮播图等「填 URL 很难找」的配置项。
   * 返回的是原图 URL（asset.url），不是缩略图；缩略图只用于列表展示。
   *
   * @param {object} opts
   * @param {boolean} [opts.multiple] 多选
   * @param {string[]} [opts.selected] 已选 URL（用于回显勾选）
   * @param {(urls:string[])=>void} [opts.onPick] 确认回调
   */
  function mediaPicker({ title = '从图片库选择', multiple = false, selected = [], onPick = null } = {}) {
    if (!document.getElementById('mp-style')) {
      const style = document.createElement('style');
      style.id = 'mp-style';
      style.textContent = `
        .mp-tools { display:flex; gap:8px; align-items:center; margin-bottom:8px; }
        .mp-tools input { flex:1; min-width:0; }
        .mp-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(118px,1fr)); gap:8px; max-height:52vh; overflow:auto; padding:4px; }
        .mp-item { appearance:none; cursor:pointer; display:flex; flex-direction:column; gap:5px; padding:6px;
          background:#17181b; border:2px solid #2f3238; border-radius:4px; color:#d7dbe2; font-family:inherit; text-align:left; }
        .mp-item:hover { border-color:#5a4a22; }
        .mp-item.on { border-color:#d9a441; box-shadow:0 0 0 2px rgba(217,164,65,.22); }
        .mp-item img { width:100%; aspect-ratio:1/1; object-fit:contain; background:#0e1013;
          background-image:repeating-conic-gradient(#1a1d22 0% 25%, #121419 0% 50%); background-size:18px 18px; }
        .mp-name { font-size:10.5px; color:#aeb4bf; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
        .mp-empty { padding:28px; text-align:center; color:#7f8792; }
        .mp-note { font-size:11px; color:#7f8792; margin-top:6px; }
      `;
      document.head.append(style);
    }

    const picked = [];
    for (const u of (Array.isArray(selected) ? selected : [])) {
      const s = String(u || '').trim();
      if (s && !picked.includes(s)) picked.push(s);
    }

    const grid = el('div', { class: 'mp-grid' });
    const status = el('div', { class: 'mp-note' });
    const search = el('input', { type: 'text', placeholder: '搜索文件名 / 标签' });
    let all = [];
    let loaded = false;

    const toggle = (url) => {
      const i = picked.indexOf(url);
      if (multiple) {
        if (i >= 0) picked.splice(i, 1); else picked.push(url);
      } else {
        picked.length = 0;
        picked.push(url);
      }
      render();
    };

    function render() {
      const q = search.value.trim().toLowerCase();
      const list = all.filter((a) => !q || `${a.originalName || ''} ${a.filename || ''} ${(a.tags || []).join(' ')}`.toLowerCase().includes(q));
      clear(grid);
      if (!loaded) {
        grid.append(el('div', { class: 'mp-empty', text: '正在读取图片库…' }));
        return;
      }
      if (!list.length) {
        grid.append(el('div', { class: 'mp-empty' },
          all.length ? '没有匹配的图片' : '图片库还是空的 —— 先到 ',
          all.length ? null : el('a', { href: '/media', target: '_blank', text: '/media' }),
          all.length ? null : ' 上传图片。',
        ));
        status.textContent = all.length ? `共 ${all.length} 张` : '';
        return;
      }
      for (const a of list) {
        const on = picked.includes(a.url);
        const btn = el('button', { class: `mp-item${on ? ' on' : ''}`, type: 'button', onclick: () => toggle(a.url) },
          el('img', { src: a.thumbnail || a.url, alt: '', loading: 'lazy' }),
          el('span', { class: 'mp-name', text: a.originalName || a.filename || a.hash }),
        );
        grid.append(btn);
      }
      status.textContent = `${list.length} 张${multiple ? ` · 已选 ${picked.length}` : ''}`;
    }

    search.addEventListener('input', render);

    const m = modal({
      title,
      wide: true,
      body: el('div', null,
        el('div', { class: 'mp-tools' }, search),
        grid,
        status,
      ),
      footer: [
        el('button', {
          class: 'btn ghost', type: 'button', text: multiple ? '清空选择' : '清空',
          onclick: () => { picked.length = 0; if (onPick) onPick([]); m.close(); },
        }),
        el('button', { class: 'btn ghost', type: 'button', text: '取消', onclick: () => m.close() }),
        el('button', {
          class: 'btn primary', type: 'button', text: '使用所选',
          onclick: () => { if (onPick) onPick(picked.slice()); m.close(); },
        }),
      ],
    });

    api('/api/media?limit=500').then((r) => {
      all = r.items || [];
      loaded = true;
      if ((r.total || 0) > all.length) status.textContent = `共 ${r.total} 张，当前显示最近 ${all.length} 张`;
      render();
    }).catch((e) => {
      loaded = true;
      all = [];
      clear(grid);
      grid.append(el('div', { class: 'mp-empty', text: `读取图片库失败：${e.message}` }));
    });

    render();
    return m;
  }

  /**
   * 签到人员编辑器 —— 抽奖页 / 签到管理页共用。
   *
   * 传 guest 为编辑，传 null 为新增。保存后如果接口只返回 guest，
   * 这里会补拉一次 state，调用方只需要 `applyState(r.state)`。
   */
  function guestEditor(guest = null, { onSaved = null, sourceLabels = null } = {}) {
    const isEdit = !!guest;
    const field = (label, input) => el('div', { class: 'field' }, el('label', { text: label }), input);
    const nameIn = el('input', { type: 'text', maxLength: 40, value: guest?.name || '', placeholder: '姓名（必填）' });
    const handleIn = el('input', { type: 'text', maxLength: 40, value: guest?.handle || '', placeholder: '昵称 / 游戏 ID（可选）' });
    const teamIn = el('input', { type: 'text', maxLength: 40, value: guest?.team || '', placeholder: '队伍（可选）' });
    const sourceLabel = guest?.source ? (sourceLabels?.[guest.source] || guest.source) : '';

    const m = modal({
      title: isEdit ? '编辑签到' : '添加签到',
      body: el('div', { class: 'editor-grid' },
        field('姓名', nameIn),
        field('昵称 / 游戏 ID', handleIn),
        field('队伍', teamIn),
        isEdit && guest?.source
          ? el('div', { class: 'small muted', text: `来源：${sourceLabel} · 签到序号 #${guest.ticket || ''}` })
          : null,
      ),
      footer: [
        el('button', { class: 'btn ghost', text: '取消', onclick: () => m.close() }),
        el('button', {
          class: 'btn primary', text: isEdit ? '保存修改' : '加入签到池',
          onclick: (e) => withBusy(e.target, async () => {
            const body = { name: nameIn.value, handle: handleIn.value, team: teamIn.value };
            try {
              let r = isEdit
                ? await api(`/api/lottery/guests/${encodeURIComponent(guest.id)}`, { method: 'PUT', body })
                : await api('/api/lottery/guests', { method: 'POST', body });
              if (!r.state) {
                const st = await api('/api/lottery/state');
                r = { ...r, state: st.state };
              }
              m.close();
              ok(isEdit ? '签到信息已更新' : `已添加：${body.name.trim()}${r.ticket ? ` · #${r.ticket}` : ''}`);
              if (onSaved) onSaved(r);
            } catch (ex) { cmdError(ex, isEdit ? '保存签到' : '添加签到'); }
          }),
        }),
      ],
    });
    setTimeout(() => nameIn.focus(), 40);
  }

  /** 删除签到人员（带二次确认），中奖者会额外提示中奖记录不受影响。 */
  async function deleteGuest(guest, { onDeleted = null, isWinner = false } = {}) {
    const name = guest?.name || '（未命名）';
    const yes = await confirm({
      title: '删除签到',
      message: `删除「${name}」这条签到记录？${isWinner ? '该人已中奖，中奖记录不会被删除。' : ''}`,
      danger: true, confirmText: '删除',
    });
    if (!yes) return false;
    try {
      const r = await api(`/api/lottery/guests/${encodeURIComponent(guest.id)}`, { method: 'DELETE', body: {} });
      ok(`已删除：${name}`);
      if (onDeleted) onDeleted(r);
      return true;
    } catch (ex) { cmdError(ex, '删除签到'); return false; }
  }

  window.ui = {
    el, $, $$, clear, esc, toast, ok, warn, err, cmdError,
    modal, confirm, prompt, playerPicker, mediaPicker, guestEditor, deleteGuest,
    topbar, mount, linkStatusBar, withBusy, sortable, poll, api,
    uploadFetch, adminToken, setAdminToken,
    CATALOG, NAV_GROUPS, NAV, featureEnabled, featureBanner,
  };
})();
