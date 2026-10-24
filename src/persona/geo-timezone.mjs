/**
 * 时区必须与出口 IP 的地理位置一致。
 *
 * 为什么这是硬约束：容器内 `curl ipinfo.io` 能直接拿到出口 IP 的国家/城市/时区，
 * 而 `date` 报的是容器 TZ。两者不符就是一眼可见的矛盾 ——
 * 出口在洛杉矶（America/Los_Angeles），系统时间却报 UTC，
 * 比不做伪装更容易被判定为异常。
 *
 * 设计原则：
 *   1. **出口优先**：如果代理配置里带了 region/expectedExitIp，以它为准
 *   2. **查不到就保守**：无法确定地理时不乱猜，退回 UTC 并标注未知
 *      （乱猜一个错误时区比 UTC 更可疑）
 *   3. **TZ 与 /etc/localtime 必须一起改**：只改 $TZ 而 /etc/localtime 还是 UTC，
 *      `date` 与 `ls -l /etc/localtime` 就对不上
 */

/** 国家/地区 → 代表时区。用于代理只给了国家码、没给具体城市时。 */
export const COUNTRY_TIMEZONES = Object.freeze({
  US: 'America/New_York',      // 默认东岸；有城市信息时会被覆盖
  CA: 'America/Toronto',
  GB: 'Europe/London',
  DE: 'Europe/Berlin',
  FR: 'Europe/Paris',
  NL: 'Europe/Amsterdam',
  IE: 'Europe/Dublin',
  ES: 'Europe/Madrid',
  IT: 'Europe/Rome',
  PL: 'Europe/Warsaw',
  SE: 'Europe/Stockholm',
  FI: 'Europe/Helsinki',
  CH: 'Europe/Zurich',
  AT: 'Europe/Vienna',
  RU: 'Europe/Moscow',
  TR: 'Europe/Istanbul',
  AE: 'Asia/Dubai',
  IL: 'Asia/Jerusalem',
  IN: 'Asia/Kolkata',
  SG: 'Asia/Singapore',
  JP: 'Asia/Tokyo',
  KR: 'Asia/Seoul',
  HK: 'Asia/Hong_Kong',
  TW: 'Asia/Taipei',
  CN: 'Asia/Shanghai',
  TH: 'Asia/Bangkok',
  VN: 'Asia/Ho_Chi_Minh',
  MY: 'Asia/Kuala_Lumpur',
  ID: 'Asia/Jakarta',
  PH: 'Asia/Manila',
  AU: 'Australia/Sydney',
  NZ: 'Pacific/Auckland',
  BR: 'America/Sao_Paulo',
  AR: 'America/Argentina/Buenos_Aires',
  MX: 'America/Mexico_City',
  CL: 'America/Santiago',
  ZA: 'Africa/Johannesburg',
  EG: 'Africa/Cairo',
  NG: 'Africa/Lagos',
  KE: 'Africa/Nairobi',
})

/**
 * 美国城市 → 时区。美国横跨多个时区，只按国家给会错。
 * 这是最容易出问题的地方：出口在洛杉矶却报 New_York，差 3 小时。
 */
export const US_CITY_TIMEZONES = Object.freeze({
  'los angeles': 'America/Los_Angeles',
  'san francisco': 'America/Los_Angeles',
  'san jose': 'America/Los_Angeles',
  'seattle': 'America/Los_Angeles',
  'portland': 'America/Los_Angeles',
  'san diego': 'America/Los_Angeles',
  'las vegas': 'America/Los_Angeles',
  'phoenix': 'America/Phoenix',
  'denver': 'America/Denver',
  'salt lake city': 'America/Denver',
  'chicago': 'America/Chicago',
  'dallas': 'America/Chicago',
  'houston': 'America/Chicago',
  'austin': 'America/Chicago',
  'minneapolis': 'America/Chicago',
  'new york': 'America/New_York',
  'newark': 'America/New_York',
  'boston': 'America/New_York',
  'philadelphia': 'America/New_York',
  'washington': 'America/New_York',
  'atlanta': 'America/New_York',
  'miami': 'America/New_York',
  'ashburn': 'America/New_York',
  'sterling': 'America/New_York',
  'charlotte': 'America/New_York',
  'columbus': 'America/New_York',
  'detroit': 'America/New_York',
  'toronto': 'America/Toronto',
  'montreal': 'America/Toronto',
})

/** 需要特殊处理的时区：有夏令时的地区，TZ 数据库能自己处理，不用额外逻辑。 */
export const DST_TIMEZONES = new Set([
  'America/Los_Angeles', 'America/Denver', 'America/Chicago',
  'America/New_York', 'America/Toronto', 'Europe/London',
  'Europe/Berlin', 'Europe/Paris', 'Europe/Amsterdam', 'Europe/Dublin',
  'Europe/Madrid', 'Europe/Rome', 'Europe/Warsaw', 'Europe/Stockholm',
  'Australia/Sydney', 'Pacific/Auckland',
])

/**
 * 从出口地理信息推导时区。
 *
 * @param {object} p
 * @param {string} [p.country]  两位国家码，如 'US'
 * @param {string} [p.city]     城市名，如 'Los Angeles'
 * @param {string} [p.timezone] 出口方直接给的时区（最可信）
 * @returns {{timezone:string|null, source:string, confidence:string}}
 */
export function timezoneForExit({ country = '', city = '', timezone = '' } = {}) {
  // 优先级 1：出口方直接给了 IANA 时区名 —— 最准，直接用
  const tzGiven = String(timezone || '').trim()
  if (tzGiven && /^[A-Za-z]+\/[A-Za-z_]+(\/[A-Za-z_]+)?$/.test(tzGiven)) {
    return { timezone: tzGiven, source: 'exit-provided', confidence: 'high' }
  }

  const cc = String(country || '').trim().toUpperCase()
  const ct = String(city || '').trim().toLowerCase()

  // 优先级 2：国家 + 城市（美国必须这么查，否则差好几个时区）
  if (cc === 'US' && ct) {
    const byCity = US_CITY_TIMEZONES[ct]
    if (byCity) return { timezone: byCity, source: 'us-city', confidence: 'high' }
  }

  // 优先级 3：只按国家
  if (cc && COUNTRY_TIMEZONES[cc]) {
    // 美国只按国家给不准，标 medium
    const conf = cc === 'US' ? 'medium' : 'high'
    return { timezone: COUNTRY_TIMEZONES[cc], source: 'country', confidence: conf }
  }

  // 查不到：不乱猜。返回 null 让调用方保留原值并记录。
  // 猜一个错的时区（比如把荷兰的出口报成 America/New_York）
  // 比保持 UTC 更容易被识别。
  return { timezone: null, source: 'unknown', confidence: 'none' }
}

/**
 * 从代理配置推导时区。
 *
 * 代理条目可能带 region 字段（如 'us-west'、'Los Angeles'），
 * 也可能只有 expectedExitIp。这里做尽力而为的解析。
 */
export function timezoneForProxy(proxy = {}) {
  const region = String(proxy.region || '').trim()

  // region 直接是 IANA 名
  if (/^[A-Za-z]+\/[A-Za-z_]+/.test(region)) {
    return { timezone: region, source: 'proxy-region-iana', confidence: 'high' }
  }

  // region 是城市名
  const lower = region.toLowerCase()
  if (US_CITY_TIMEZONES[lower]) {
    return { timezone: US_CITY_TIMEZONES[lower], source: 'proxy-region-city', confidence: 'high' }
  }

  // region 形如 "us-west" / "us-east"
  const m = lower.match(/^([a-z]{2})[-_]([a-z]+)$/)
  if (m) {
    const [, cc, dir] = m
    const DIR = {
      'us-west': 'America/Los_Angeles',
      'us-east': 'America/New_York',
      'us-central': 'America/Chicago',
      'us-south': 'America/Chicago',
      'eu-west': 'Europe/London',
      'eu-central': 'Europe/Berlin',
      'eu-north': 'Europe/Stockholm',
      'ap-southeast': 'Asia/Singapore',
      'ap-northeast': 'Asia/Tokyo',
      'ap-south': 'Asia/Kolkata',
    }
    const hit = DIR[`${cc}-${dir}`]
    if (hit) return { timezone: hit, source: 'proxy-region-dir', confidence: 'medium' }
    return timezoneForExit({ country: cc })
  }

  return { timezone: null, source: 'unknown', confidence: 'none' }
}
