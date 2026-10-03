const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH=/^[0-9a-f]{64}$/;
const LEGACY_KEY=/^snapshots\/\d{4}-\d{2}-\d{2}\/([0-9a-f-]{36})\.tar\.gz\.gpg$/;

export function isNativeBackupKey(key: unknown): key is string {
  if (typeof key !== 'string' || key.trim() !== key) return false;
  const match = /^snapshots-v2\/(\d{4}-\d{2}-\d{2})\/([0-9a-f-]{36})\/(manifest\.json|control\.json|database-schema\.json|source-manifest\.json|snapshot-deletions\.json|database\/[a-zA-Z_][a-zA-Z0-9_]*\/(?:0|[1-9][0-9]*)\.json|objects\/[0-9a-f]{64}\.bin)$/.exec(key);
  return !!match && UUID.test(match[2]);
}

export function retainedBackupKeys(objects:Array<{key:string;uploaded:Date;customMetadata?:Record<string,string>}>):Set<string> {
  const sorted=objects.filter(o=>(LEGACY_KEY.test(o.key) || (isNativeBackupKey(o.key) && o.key.endsWith('/manifest.json'))) && HASH.test(o.customMetadata?.manifest_sha256 ?? '')).sort((a,b)=>b.uploaded.getTime()-a.uploaded.getTime());
  const keep=new Set<string>(),days=new Set<string>(),weeks=new Set<string>();
  for(const item of sorted) {
    const date=new Date(item.uploaded),day=date.toISOString().slice(0,10);
    // ISO week identity uses the Thursday belonging to this week.
    date.setUTCHours(0,0,0,0);date.setUTCDate(date.getUTCDate()+4-(date.getUTCDay() || 7));
    const week=`${date.getUTCFullYear()}-${Math.ceil((((date.getTime()-Date.UTC(date.getUTCFullYear(),0,1))/86400000)+1)/7)}`;
    if(!days.has(day) && days.size<7) {days.add(day);keep.add(item.key)}
    if(!weeks.has(week) && weeks.size<4) {weeks.add(week);keep.add(item.key)}
  }
  return keep;
}
