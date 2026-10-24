/**
 * 路由层统一响应格式。
 *
 * 之前 7 个 route 文件各自抄了一份一模一样的 respond；这里收成一处，
 * 以后要改错误码 / 字段顺序只改这里。
 *
 *   · 模块函数返回 { ok:false, nack:{ code,msg } } → HTTP 400 + 原样 JSON
 *   · 其余结果统一补 ok:true
 */
export function respond(res, r) {
  if (r && r.ok === false) return res.status(400).json(r);
  res.json(r === undefined ? { ok: true } : { ...r, ok: true });
}

/** 明确的失败响应（没有模块返回对象时用） */
export function fail(res, code, msg, status = 400) {
  return res.status(status).json({ ok: false, nack: { code, msg } });
}
