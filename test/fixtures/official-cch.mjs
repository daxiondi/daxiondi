// 官方 cli.js 的 cch 投影实现（逐字抽取，不要修改）
// 来源: research/payload/extracted/cli.js:83400-83517
// 用途: 作为 cch 对拍的黄金参考
function cut(s2, start, end) {
  if (end < s2.length && s2[end] === ",")
    end += 1;
  else if (start > 0 && s2[start - 1] === ",")
    start -= 1;
  return s2.slice(0, start) + s2.slice(end);
}

function blankStringModels(s2) {
  const needle = '"model":"';
  const out = [];
  let i3 = 0;
  while (true) {
    const j3 = s2.indexOf(needle, i3);
    if (j3 < 0) {
      out.push(s2.slice(i3));
      break;
    }
    let k2 = j3 + needle.length;
    while (k2 < s2.length) {
      if (s2[k2] === "\\" && k2 + 1 < s2.length) {
        k2 += 2;
        continue;
      }
      if (s2[k2] === '"')
        break;
      k2 += 1;
    }
    out.push(s2.slice(i3, j3 + needle.length));
    i3 = k2;
  }
  return out.join("");
}

function skipFallbacks(s2) {
  const needle = '"fallbacks":[';
  const j3 = s2.indexOf(needle);
  if (j3 < 0)
    return s2;
  let i3 = j3 + needle.length - 1;
  let depth = 0;
  let inStr = false;
  let esc2 = false;
  while (i3 < s2.length) {
    const c4 = s2[i3];
    if (inStr) {
      if (esc2)
        esc2 = false;
      else if (c4 === "\\")
        esc2 = true;
      else if (c4 === '"')
        inStr = false;
    } else if (c4 === '"')
      inStr = true;
    else if (c4 === "[")
      depth += 1;
    else if (c4 === "]") {
      depth -= 1;
      if (depth === 0)
        return cut(s2, j3, i3 + 1);
    }
    i3 += 1;
  }
  return s2;
}

function skipCredit(s2) {
  const needle = '"fallback_credit_token":"';
  const j3 = s2.indexOf(needle);
  if (j3 < 0)
    return s2;
  let k2 = j3 + needle.length;
  while (k2 < s2.length) {
    if (s2[k2] === "\\" && k2 + 1 < s2.length) {
      k2 += 2;
      continue;
    }
    if (s2[k2] === '"')
      return cut(s2, j3, k2 + 1);
    k2 += 1;
  }
  return s2;
}

function skipMaxTokens(s2) {
  const needle = '"max_tokens":';
  const j3 = s2.indexOf(needle);
  if (j3 < 0)
    return s2;
  let k2 = j3 + needle.length;
  if (k2 >= s2.length || !/[0-9]/.test(s2[k2]))
    return s2;
  while (k2 < s2.length && /[0-9]/.test(s2[k2]))
    k2 += 1;
  return cut(s2, j3, k2);
}

function projectForCch(body) {
  let material = body;
  try {
    const parsed = JSON.parse(body);
    const compact = JSON.stringify(parsed);
    if (typeof compact === "string")
      material = compact;
  } catch {}
  const reset2 = material.replace(/(x-anthropic-billing-header:[^"]*?\bcch=)[0-9a-f]{5}(?=;)/i, (_match, prefix) => `${prefix}00000`);
  return skipMaxTokens(skipCredit(skipFallbacks(blankStringModels(reset2))));
}

export { projectForCch }
