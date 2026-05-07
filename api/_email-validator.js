// Lightweight fake-email detector. Optimised for catching the obvious cases
// that show up when a free tool has no double-opt-in.
//
// Returns { fake: boolean, reason?: string, didYouMean?: string }.
// Be conservative — when unsure, accept. False rejections are worse than
// false acceptances (we lose a real lead).

const VALID_TLDS = new Set([
  // Generic
  'com','net','org','edu','gov','mil','int','co','io','app','dev','tech','xyz','online','site','store','shop','biz','info','pro','name','mobi','ai','design','studio','works','digital','media','agency','plus','live','life','world',
  // Europe
  'de','fr','it','es','uk','gb','nl','at','ch','be','pl','pt','se','no','dk','fi','cz','sk','hu','ro','gr','ie','lt','lv','ee','si','hr','bg','tr','ru','ua','rs','mt','cy','lu','is','mc','li','sm','va','ad','by','md','al','mk','me','ba','xk',
  // Americas
  'us','ca','mx','br','ar','cl','pe','co','ec','uy','py','bo','ve','cr','pa','do','gt','hn','ni','sv','jm','tt','bs','bb','ht','cu','pr',
  // APAC + ME + Africa
  'au','nz','jp','kr','cn','hk','tw','sg','th','vn','ph','my','id','in','pk','bd','lk','np','kh','la','mm','mn','bt','mv','ae','sa','il','eg','za','ng','ke','gh','ma','tn','dz','et','ug','tz','rw','sn','ci','cm','zw','zm','mu','mg','sc',
  // Specials and brand
  'tv','cc','to','ly','sh','asia','eu','blog','cloud','email','social','services','solutions','company','group','team','one','space',
  // Org
  'cat','aero','coop','jobs','museum','tel',
]);

const DISPOSABLE_DOMAINS = new Set([
  'mailinator.com','tempmail.com','10minutemail.com','guerrillamail.com',
  'throwaway.email','sharklasers.com','temp-mail.org','yopmail.com',
  'inraud.com','yoomail.com','trashmail.com','dispostable.com',
  'maildrop.cc','mintemail.com','minutemail.com','tempinbox.com',
  'getnada.com','fakeinbox.com','spamgourmet.com','tempr.email',
]);

const TYPO_DOMAINS = {
  'gmaio.com': 'gmail.com', 'gmaol.com': 'gmail.com', 'gmzil.com': 'gmail.com',
  'gnail.com': 'gmail.com', 'gmial.com': 'gmail.com', 'gmsil.com': 'gmail.com',
  'gmali.com': 'gmail.com', 'gmaill.com': 'gmail.com', 'gmaul.com': 'gmail.com',
  'yaho.com': 'yahoo.com', 'yahooo.com': 'yahoo.com', 'yahho.com': 'yahoo.com',
  'hotnail.com': 'hotmail.com', 'hotmial.com': 'hotmail.com', 'hotmal.com': 'hotmail.com',
  'outlok.com': 'outlook.com', 'outloook.com': 'outlook.com',
  'icoud.com': 'icloud.com', 'iclud.com': 'icloud.com', 'icould.com': 'icloud.com',
  'gmx.dei': 'gmx.de',
};

const TEST_LOCAL = /^(test|demo|fake|invalid|asdf+|qwerty|admin|noreply|fart|abc|xyz|123|aaa+|user|guest|sample|temp|tmp)\d*$/i;
const TEST_DOMAIN = /^(test|example|fake|invalid|nowhere|asdf|temp|sample)\./i;

function isLikelyFakeEmail(email) {
  if (!email || typeof email !== 'string') return { fake: true, reason: 'missing' };
  const e = email.trim().toLowerCase();
  // Basic format
  const m = e.match(/^([a-z0-9._%+\-]+)@([a-z0-9\-]+(?:\.[a-z0-9\-]+)*)\.([a-z]{2,})$/);
  if (!m) return { fake: true, reason: 'invalid_format' };
  const [, local, domainBody, tld] = m;
  const domain = domainBody + '.' + tld;
  if (!VALID_TLDS.has(tld)) return { fake: true, reason: 'unknown_tld', tld };
  if (TYPO_DOMAINS[domain]) return { fake: true, reason: 'typo_domain', didYouMean: TYPO_DOMAINS[domain] };
  if (DISPOSABLE_DOMAINS.has(domain)) return { fake: true, reason: 'disposable' };
  if (local.length < 3) return { fake: true, reason: 'local_too_short' };
  if (domainBody.length < 2) return { fake: true, reason: 'domain_too_short' };
  if (/(.)\1{3,}/.test(local)) return { fake: true, reason: 'repeated_chars' };
  if (/(.)\1{3,}/.test(domainBody)) return { fake: true, reason: 'repeated_chars_domain' };
  if (local === domainBody && local.length <= 6) return { fake: true, reason: 'matches_domain' };
  if (TEST_LOCAL.test(local)) return { fake: true, reason: 'test_pattern' };
  if (TEST_DOMAIN.test(domain)) return { fake: true, reason: 'test_domain' };
  return { fake: false };
}

module.exports = { isLikelyFakeEmail, VALID_TLDS, DISPOSABLE_DOMAINS, TYPO_DOMAINS };
