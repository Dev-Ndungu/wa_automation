import { useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

const api = 'http://127.0.0.1:3001';
type Status = { state: string; phone: string | null; lastConnectedAt: string | null; qrDataUrl: string | null; error: string | null };
type Group = { whatsappGroupJid: string; name: string; isScannerEnabled: boolean; isExcluded: boolean };
type Link = { id: string; inviteUrl: string; sourceGroupName: string; firstSeenAt: string; timesSeen: number; status: string };
type CampaignTarget = { groupJid: string; groupName: string; status: 'QUEUED' | 'WAITING' | 'SENDING' | 'SENT' | 'FAILED' | 'CANCELLED'; sentAt?: string | null; errorMessage?: string | null };
type Campaign = { id: string; name: string; status: string; targets: CampaignTarget[]; sourceMessageReference: string; sourceContent?: { text: string; hasImage: boolean } | null; intervalSecondsList?: string; scheduleConfig?: string; nextRunAt?: string | null };

async function request(path: string, init?: RequestInit) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(`${api}${path}`, init);
    } catch (error) {
      lastError = error;
      if (attempt < 2) await new Promise((resolve) => window.setTimeout(resolve, 400 * (attempt + 1)));
      continue;
    }
    const body = await response.json().catch(() => null);
    if (!response.ok) throw new Error(body?.message ?? 'Request failed.');
    return body;
  }
  throw lastError instanceof Error ? lastError : new Error('Local API connection failed.');
}

function intervalSummary(campaign: Campaign) {
  try {
    const intervals = JSON.parse(campaign.intervalSecondsList ?? '[]');
    if (Array.isArray(intervals) && intervals.every((value) => Number.isInteger(value))) return `${intervals.join('s → ')}s`;
  } catch { /* Legacy campaigns simply do not show an interval sequence. */ }
  return 'No interval sequence saved';
}

function scheduleSummary(campaign: Campaign) {
  try {
    const schedule = JSON.parse(campaign.scheduleConfig ?? '{"type":"ONCE"}');
    const labels: Record<string, string> = {
      ONCE: 'One-time campaign',
      MINUTELY: `Every ${schedule.intervalMinutes} minute(s)`, HOURLY: `Every ${schedule.intervalHours} hour(s)`,
      DAILY: `Daily at ${schedule.time}`,
      EVERY_N_DAYS: `Every ${schedule.intervalDays} days at ${schedule.time}`,
      WEEKLY: `Weekly at ${schedule.time}`,
    };
    const next = campaign.nextRunAt ? ` · next: ${new Date(campaign.nextRunAt).toLocaleString()}` : '';
    return `${labels[schedule.type] ?? 'Scheduled campaign'}${next}`;
  } catch { return 'Saved schedule'; }
}

function App() {
  const [page, setPage] = useState<'home' | 'groups' | 'links' | 'campaigns'>('home');
  const [status, setStatus] = useState<Status | null>(null);
  const [groups, setGroups] = useState<Group[]>([]);
  const [links, setLinks] = useState<Link[]>([]);
  const [autoJoin, setAutoJoin] = useState(false);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [source, setSource] = useState('');
  const [imageDataUrl, setImageDataUrl] = useState('');
  const [imageInputKey, setImageInputKey] = useState(0);
  const [campaignName, setCampaignName] = useState('');
  const [selectedGroupJids, setSelectedGroupJids] = useState<string[]>([]);
  const [intervals, setIntervals] = useState<string[]>(['60']);
  const [intervalUnit, setIntervalUnit] = useState<'seconds' | 'minutes'>('seconds');
  const [scheduleType, setScheduleType] = useState<'ONCE' | 'MINUTELY' | 'HOURLY' | 'DAILY' | 'EVERY_N_DAYS' | 'WEEKLY'>('ONCE');
  const [scheduleTime, setScheduleTime] = useState('17:00');
  const [intervalHours, setIntervalHours] = useState('1');
  const [intervalMinutes, setIntervalMinutes] = useState('15');
  const [intervalDays, setIntervalDays] = useState('3');
  const [weekdays, setWeekdays] = useState<number[]>([1]);
  const [groupSearch, setGroupSearch] = useState('');
  const [linkGroupJids, setLinkGroupJids] = useState<string[]>([]);
  const [lookbackValue, setLookbackValue] = useState('24');
  const [lookbackUnit, setLookbackUnit] = useState<'hours' | 'days'>('hours');
  const [appliedLinkFilters, setAppliedLinkFilters] = useState({ groupJids: [] as string[], lookbackHours: 24 });
  const [groupInviteLinks, setGroupInviteLinks] = useState<Record<string, string>>({});
  const [editingCampaign, setEditingCampaign] = useState<Campaign | null>(null);
  const [editingSourceText, setEditingSourceText] = useState('');
  const [editingHadImage, setEditingHadImage] = useState(false);
  const [imageWasRemoved, setImageWasRemoved] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const linkQuery = new URLSearchParams({ limit: '100' });
      if (appliedLinkFilters.groupJids.length) linkQuery.set('groupJids', appliedLinkFilters.groupJids.join(','));
      if (appliedLinkFilters.lookbackHours > 0) linkQuery.set('lookbackHours', String(appliedLinkFilters.lookbackHours));
      const [nextStatus, nextGroups, nextLinks, nextCampaigns, nextAutoJoin] = await Promise.all([
        request('/api/whatsapp/status'), request('/api/groups'), request(`/api/links?${linkQuery}`), request('/api/campaigns'), request('/api/links/auto-join'),
      ]);
      setStatus(nextStatus); setGroups(nextGroups); setLinks(nextLinks.items); setCampaigns(nextCampaigns); setAutoJoin(nextAutoJoin.enabled); setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Local API unavailable.');
    }
  }, [appliedLinkFilters]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5_000);
    return () => clearInterval(timer);
  }, [refresh]);

  async function act(path: string, body?: unknown) {
    try {
      const result = await request(path, { method: 'POST', headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
      setMessage('Saved.');
      await refresh();
      return result;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Action failed.');
      return null;
    }
  }

  async function updateGroup(group: Group, changes: Partial<Group>) {
    try {
      await request(`/api/groups/${encodeURIComponent(group.whatsappGroupJid)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(changes) });
      if (changes.isExcluded) setSelectedGroupJids((selected) => selected.filter((jid) => jid !== group.whatsappGroupJid));
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not update group.');
    }
  }

  function toggleCampaignGroup(jid: string) {
    setSelectedGroupJids((selected) => selected.includes(jid) ? selected.filter((selectedJid) => selectedJid !== jid) : [...selected, jid]);
  }

  function setIntervalValue(index: number, value: string) {
    setIntervals((current) => current.map((interval, currentIndex) => currentIndex === index ? value : interval));
  }

  function toggleWeekday(day: number) {
    setWeekdays((current) => current.includes(day) ? current.filter((value) => value !== day) : [...current, day].sort());
  }

  function applyLookback() {
    const hours = Number(lookbackValue) * (lookbackUnit === 'days' ? 24 : 1);
    if (!Number.isFinite(hours) || hours <= 0) { setError('Enter a look-back time greater than zero.'); return; }
    setAppliedLinkFilters({ groupJids: linkGroupJids, lookbackHours: hours });
    setMessage(`Showing links found in the last ${lookbackValue} ${lookbackUnit}.`);
  }

  async function showGroupInviteLink(group: Group) {
    try {
      const result = await request(`/api/groups/${encodeURIComponent(group.whatsappGroupJid)}/invite-link`);
      setGroupInviteLinks((current) => ({ ...current, [group.whatsappGroupJid]: result.inviteUrl }));
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not get the group invite link.'); }
  }

  async function createCampaign(startAfterCreate = false) {
    const intervalValues = intervals.map((interval) => Number(interval) * (intervalUnit === 'minutes' ? 60 : 1));
    if (!source.trim() || !campaignName.trim()) { setError('Enter a campaign name and source message.'); return; }
    if (selectedGroupJids.length === 0) { setError('Select at least one group for this campaign.'); return; }
    if (intervalValues.some((interval) => !Number.isInteger(interval) || interval < 0 || interval > 86_400)) {
      setError('Each wait interval must be a whole number of seconds from 0 to 86400.'); return;
    }
    if (scheduleType === 'MINUTELY' && (!Number.isInteger(Number(intervalMinutes)) || Number(intervalMinutes) < 1 || Number(intervalMinutes) > 10080)) { setError('Minute repeat must be from 1 to 10080 minutes.'); return; }
    if (scheduleType === 'HOURLY' && (!Number.isInteger(Number(intervalHours)) || Number(intervalHours) < 1 || Number(intervalHours) > 168)) {
      setError('Hourly repeat must be a whole number from 1 to 168 hours.'); return;
    }
    if (scheduleType === 'EVERY_N_DAYS' && (!Number.isInteger(Number(intervalDays)) || Number(intervalDays) < 2 || Number(intervalDays) > 365)) {
      setError('Day repeat must be a whole number from 2 to 365 days.'); return;
    }
    if (['DAILY', 'EVERY_N_DAYS', 'WEEKLY'].includes(scheduleType) && !/^([01]\d|2[0-3]):[0-5]\d$/.test(scheduleTime)) {
      setError('Choose a valid 24-hour start time.'); return;
    }
    if (scheduleType === 'WEEKLY' && weekdays.length === 0) { setError('Select at least one weekday.'); return; }
    const schedule = scheduleType === 'ONCE' ? { type: 'ONCE' }
      : scheduleType === 'MINUTELY' ? { type: 'MINUTELY', intervalMinutes: Number(intervalMinutes) }
      : scheduleType === 'HOURLY' ? { type: 'HOURLY', intervalHours: Number(intervalHours) }
      : scheduleType === 'DAILY' ? { type: 'DAILY', time: scheduleTime }
      : scheduleType === 'EVERY_N_DAYS' ? { type: 'EVERY_N_DAYS', intervalDays: Number(intervalDays), time: scheduleTime }
      : { type: 'WEEKLY', weekdays, time: scheduleTime };
    const saved = await act('/api/campaigns/source-messages/manual', { text: source, label: campaignName, imageDataUrl: imageDataUrl || undefined });
    if (!saved) return;
    const campaign = await act('/api/campaigns', {
      name: campaignName, sourceMessageId: saved.id, groupJids: selectedGroupJids, intervalSeconds: intervalValues, schedule,
    });
    if (campaign) {
      clearCampaignForm();
      if (startAfterCreate) {
        const started = await act(`/api/campaigns/${campaign.id}/start`);
        setMessage(started ? 'Campaign created and started.' : 'Campaign created as a draft. Start it from campaign history when ready.');
      } else setMessage('Campaign created. Press Start when ready.');
    }
  }

  function clearCampaignForm() {
    setSource(''); setImageDataUrl(''); setImageInputKey((key) => key + 1); setCampaignName(''); setSelectedGroupJids([]); setIntervals(['60']); setIntervalUnit('seconds'); setScheduleType('ONCE');
    setEditingCampaign(null); setEditingSourceText(''); setEditingHadImage(false); setImageWasRemoved(false);
  }

  function beginCampaignEdit(campaign: Campaign) {
    if (campaign.status === 'RUNNING') { setError('Pause this campaign before editing it. Its live run will continue until you pause or stop it.'); return; }
    let schedule: Record<string, unknown> = { type: 'ONCE' };
    try { schedule = JSON.parse(campaign.scheduleConfig ?? '{"type":"ONCE"}'); } catch { /* Keep the safe one-time default. */ }
    let savedIntervals: string[] = ['60'];
    try {
      const parsed = JSON.parse(campaign.intervalSecondsList ?? '[60]');
      if (Array.isArray(parsed) && parsed.every((value) => Number.isInteger(value))) savedIntervals = parsed.map(String);
    } catch { /* Keep the default interval. */ }
    setEditingCampaign(campaign); setCampaignName(campaign.name); setSource(campaign.sourceContent?.text ?? ''); setEditingSourceText(campaign.sourceContent?.text ?? '');
    setEditingHadImage(Boolean(campaign.sourceContent?.hasImage)); setImageWasRemoved(false); setImageDataUrl(''); setImageInputKey((key) => key + 1);
    const eligibleGroupJids = new Set(groups.filter((group) => !group.isExcluded).map((group) => group.whatsappGroupJid));
    const editableTargets = campaign.targets.map((target) => target.groupJid).filter((jid) => eligibleGroupJids.has(jid));
    const excludedTargetCount = campaign.targets.length - editableTargets.length;
    setSelectedGroupJids(editableTargets); setIntervals(savedIntervals); setIntervalUnit('seconds');
    setScheduleType((schedule.type as typeof scheduleType) ?? 'ONCE');
    setIntervalMinutes(String(schedule.intervalMinutes ?? 15)); setIntervalHours(String(schedule.intervalHours ?? 1)); setIntervalDays(String(schedule.intervalDays ?? 3));
    setScheduleTime(typeof schedule.time === 'string' ? schedule.time : '17:00'); setWeekdays(Array.isArray(schedule.weekdays) ? schedule.weekdays as number[] : [1]);
    setMessage(excludedTargetCount > 0
      ? `Editing “${campaign.name}”. ${excludedTargetCount} excluded group(s) were removed from this campaign.`
      : `Editing “${campaign.name}”. Save changes when ready.`);
  }

  async function saveCampaignEdit() {
    if (!editingCampaign) return;
    if (!source.trim() || !campaignName.trim() || selectedGroupJids.length === 0) { setError('Enter a campaign name, message, and at least one group.'); return; }
    const intervalValues = intervals.map((interval) => Number(interval) * (intervalUnit === 'minutes' ? 60 : 1));
    if (intervalValues.some((interval) => !Number.isInteger(interval) || interval < 0 || interval > 86_400)) { setError('Each wait interval must be a whole number of seconds from 0 to 86400.'); return; }
    const schedule = scheduleType === 'ONCE' ? { type: 'ONCE' }
      : scheduleType === 'MINUTELY' ? { type: 'MINUTELY', intervalMinutes: Number(intervalMinutes) }
      : scheduleType === 'HOURLY' ? { type: 'HOURLY', intervalHours: Number(intervalHours) }
      : scheduleType === 'DAILY' ? { type: 'DAILY', time: scheduleTime }
      : scheduleType === 'EVERY_N_DAYS' ? { type: 'EVERY_N_DAYS', intervalDays: Number(intervalDays), time: scheduleTime }
      : { type: 'WEEKLY', weekdays, time: scheduleTime };
    let sourceMessageId = editingCampaign.sourceMessageReference;
    if (source !== editingSourceText || imageDataUrl || imageWasRemoved) {
      const saved = await act('/api/campaigns/source-messages/manual', { text: source, label: campaignName, imageDataUrl: imageDataUrl || undefined });
      if (!saved) return;
      sourceMessageId = saved.id;
    }
    try {
      await request(`/api/campaigns/${editingCampaign.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: campaignName, sourceMessageId, groupJids: selectedGroupJids, intervalSeconds: intervalValues, schedule }) });
      setMessage('Campaign changes saved.'); clearCampaignForm(); await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not save campaign changes.'); }
  }

  const connected = status?.state === 'CONNECTED';
  const campaignGroups = groups.filter((group) => !group.isExcluded);
  const shownGroups = campaignGroups.filter((group) => `${group.name} ${group.whatsappGroupJid}`.toLowerCase().includes(groupSearch.trim().toLowerCase()));
  return <main><section className="card wide">
    <header><div><p className="eyebrow">LOCAL DASHBOARD</p><h1>WhatsApp Group Control</h1></div><span className={`badge ${connected ? 'ok' : ''}`}>{status?.state ?? 'LOADING'}</span></header>
    <nav>{(['home', 'groups', 'links', 'campaigns'] as const).map((item) => <button key={item} className={page === item ? '' : 'secondary'} onClick={() => setPage(item)}>{item[0].toUpperCase() + item.slice(1)}</button>)}</nav>
    {page === 'home' && <section className="panel"><h2>WhatsApp connection</h2><p>{connected ? `Linked phone: ${status?.phone}` : status?.state === 'QR_READY' ? 'Scan this QR code in WhatsApp to link this device.' : 'Not linked'}</p>{status?.qrDataUrl && <div className="qr-panel"><img src={status.qrDataUrl} alt="WhatsApp linking QR code" /><p>WhatsApp → Settings → Linked devices → Link a device</p></div>}{connected ? <button onClick={() => void act('/api/whatsapp/sync-groups')}>Refresh groups</button> : <button onClick={() => void act('/api/whatsapp/link')}>{status?.state === 'QR_READY' ? 'Generate a new QR code' : 'Link WhatsApp'}</button>}<p>Scanner is running locally. It only records group invite links; it does not join groups or send automatically.</p></section>}
    {page === 'groups' && <section className="panel"><h2>Groups ({groups.length})</h2><p>Excluded groups are neither scanned nor available for campaigns. You can also retrieve each group’s current WhatsApp invite link here.</p><div className="list">{groups.map((group) => <div className="row" key={group.whatsappGroupJid}><div><strong>{group.name}</strong>{group.isExcluded && <span className="muted"> · Excluded</span>}{groupInviteLinks[group.whatsappGroupJid] && <><br /><a href={groupInviteLinks[group.whatsappGroupJid]} target="_blank" rel="noreferrer">Open WhatsApp group link</a></>}</div><div className="row-actions"><label><input type="checkbox" checked={group.isScannerEnabled} disabled={group.isExcluded} onChange={(event) => void updateGroup(group, { isScannerEnabled: event.target.checked })} /> Scan</label><label><input type="checkbox" checked={group.isExcluded} onChange={(event) => void updateGroup(group, { isExcluded: event.target.checked })} /> Exclude</label><button className="secondary" onClick={() => void showGroupInviteLink(group)}>Get WhatsApp link</button></div></div>)}</div></section>}
    {page === 'links' && <section className="panel"><h2>Saved link history</h2><p>{links.length} matching links. Successfully joined links are removed from this list.</p><div className="history-filter"><label>Look back<input type="number" min="1" value={lookbackValue} onChange={(event) => setLookbackValue(event.target.value)} /></label><select value={lookbackUnit} onChange={(event) => setLookbackUnit(event.target.value as 'hours' | 'days')}><option value="hours">hours</option><option value="days">days</option></select><button onClick={applyLookback}>Look back now</button></div><details><summary>Select source groups to include</summary>{groups.filter((group) => !group.isExcluded).map((group) => <label className="daily-toggle" key={group.whatsappGroupJid}><input type="checkbox" checked={linkGroupJids.includes(group.whatsappGroupJid)} onChange={() => setLinkGroupJids((current) => current.includes(group.whatsappGroupJid) ? current.filter((jid) => jid !== group.whatsappGroupJid) : [...current, group.whatsappGroupJid])} /> {group.name}</label>)}</details><label className="daily-toggle"><input type="checkbox" checked={autoJoin} onChange={(event) => void request('/api/links/auto-join', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: event.target.checked }) }).then((result) => { setAutoJoin(result.enabled); setMessage(result.enabled ? 'Auto-join enabled for newly discovered links.' : 'Auto-join disabled.'); }).catch((cause) => setError(cause instanceof Error ? cause.message : 'Could not change auto-join.'))} /> Auto-join newly discovered links</label><div className="list">{links.map((link) => <div className="row" key={link.id}><div><strong>{link.sourceGroupName}</strong><br /><a href={link.inviteUrl} target="_blank" rel="noreferrer">Open link</a><br />Found {new Date(link.firstSeenAt).toLocaleString()} · Seen {link.timesSeen} times</div><button className="secondary" onClick={() => void navigator.clipboard.writeText(link.inviteUrl)}>Copy</button><button onClick={() => { if (window.confirm(`Join the group from this invite link?\n\n${link.inviteUrl}`)) void act(`/api/links/${link.id}/join`).then((result) => { if (result) setMessage('Joined group and removed the link from this list.'); }); }}>Join group</button><select value={link.status} onChange={(event) => void request(`/api/links/${link.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: event.target.value }) }).then(refresh)}><option>NEW</option><option>VIEWED</option><option>USED</option><option>ARCHIVED</option></select></div>)}</div><a className="download" href={`${api}/api/links/export.csv`}>Download CSV</a></section>}
    {page === 'campaigns' && <section className="panel"><h2>{editingCampaign ? `Edit campaign: ${editingCampaign.name}` : 'New campaign'}</h2><p>Scheduling decides when a campaign begins. Wait intervals only pace sends from one selected group to the next. Live progress refreshes safely every few seconds.</p>{editingCampaign && <button className="secondary" onClick={clearCampaignForm}>Cancel edit</button>}<input placeholder="Campaign name" value={campaignName} onChange={(event) => setCampaignName(event.target.value)} /><textarea placeholder="Message or image caption" value={source} onChange={(event) => setSource(event.target.value)} /><input key={imageInputKey} type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => { const file = event.target.files?.[0]; if (!file) return; if (file.size > 4 * 1024 * 1024) { setError('Choose an image smaller than 4 MB.'); event.target.value = ''; return; } const reader = new FileReader(); reader.onerror = () => setError('Could not read that image.'); reader.onload = () => setImageDataUrl(String(reader.result)); reader.readAsDataURL(file); }} />{(imageDataUrl || (editingHadImage && !imageWasRemoved)) && <div className="image-preview">{imageDataUrl ? <img src={imageDataUrl} alt="Campaign attachment preview" /> : <span>Existing image attachment will be kept.</span>}<button className="secondary" onClick={() => { setImageDataUrl(''); setImageWasRemoved(true); setImageInputKey((key) => key + 1); }}>× Remove image</button></div>}
      <h3>Recipient groups ({selectedGroupJids.length} / {campaignGroups.length})</h3><input placeholder="Search groups" value={groupSearch} onChange={(event) => setGroupSearch(event.target.value)} /><div className="selection-actions"><button className="secondary" onClick={() => setSelectedGroupJids((current) => [...new Set([...current, ...shownGroups.map((group) => group.whatsappGroupJid)])])}>Select shown</button><button className="secondary" onClick={() => setSelectedGroupJids(campaignGroups.map((group) => group.whatsappGroupJid))}>Select all</button><button className="secondary" onClick={() => setSelectedGroupJids([])}>Clear selection</button></div><div className="list target-list">{shownGroups.map((group) => <label className="row selectable" key={group.whatsappGroupJid}><input type="checkbox" checked={selectedGroupJids.includes(group.whatsappGroupJid)} onChange={() => toggleCampaignGroup(group.whatsappGroupJid)} /><strong>{group.name}</strong></label>)}</div>
      <h3>When should this campaign run?</h3><select value={scheduleType} onChange={(event) => setScheduleType(event.target.value as typeof scheduleType)}><option value="ONCE">Run once, when I press Start</option><option value="MINUTELY">Repeat every number of minutes</option><option value="HOURLY">Repeat every number of hours</option><option value="DAILY">Run every day at a time</option><option value="EVERY_N_DAYS">Run every number of days</option><option value="WEEKLY">Run weekly on selected days</option></select>{scheduleType === 'MINUTELY' && <label className="time-input">Repeat every (minutes)<input type="number" min="1" max="10080" step="1" value={intervalMinutes} onChange={(event) => setIntervalMinutes(event.target.value)} /></label>}{scheduleType === 'HOURLY' && <label className="time-input">Repeat every (hours)<input type="number" min="1" max="168" step="1" value={intervalHours} onChange={(event) => setIntervalHours(event.target.value)} /></label>}{['DAILY', 'EVERY_N_DAYS', 'WEEKLY'].includes(scheduleType) && <label className="time-input">Start time (24-hour clock)<input type="time" value={scheduleTime} onChange={(event) => setScheduleTime(event.target.value)} /></label>}{scheduleType === 'EVERY_N_DAYS' && <label className="time-input">Repeat every (days)<input type="number" min="2" max="365" step="1" value={intervalDays} onChange={(event) => setIntervalDays(event.target.value)} /></label>}{scheduleType === 'WEEKLY' && <div className="weekdays">{['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((name, day) => <label key={name}><input type="checkbox" checked={weekdays.includes(day)} onChange={() => toggleWeekday(day)} /> {name}</label>)}</div>}
      <h3>Wait intervals between groups</h3><p className="hint">Choose seconds or minutes, then enter the wait after each send. The list repeats in order.</p><select value={intervalUnit} onChange={(event) => setIntervalUnit(event.target.value as 'seconds' | 'minutes')}><option value="seconds">Seconds</option><option value="minutes">Minutes</option></select><div className="intervals">{intervals.map((interval, index) => <div className="interval-row" key={index}><label>After send {index + 1} ({intervalUnit})<input type="number" min="0" max={intervalUnit === 'minutes' ? 1440 : 86400} step="1" value={interval} onChange={(event) => setIntervalValue(index, event.target.value)} /></label>{intervals.length > 1 && <button className="secondary" onClick={() => setIntervals((current) => current.filter((_, currentIndex) => currentIndex !== index))}>Remove</button>}</div>)}</div><button className="secondary" onClick={() => setIntervals((current) => current.length >= 20 ? current : [...current, intervalUnit === 'minutes' ? '1' : '60'])}>Add another wait interval</button>{editingCampaign ? <button onClick={() => void saveCampaignEdit()}>Save campaign changes</button> : <><button onClick={() => void createCampaign()}>Create campaign</button>{selectedGroupJids.length > 0 && <button onClick={() => void createCampaign(true)}>Create and start campaign</button>}</>}
      <h2>Campaign history</h2><div className="list">{campaigns.map((campaign) => { const sent = campaign.targets.filter((target) => target.status === 'SENT').length; const sending = campaign.targets.filter((target) => target.status === 'SENDING').length; const failed = campaign.targets.filter((target) => target.status === 'FAILED').length; const waiting = campaign.targets.length - sent - failed - sending; return <div className="row campaign-row" key={campaign.id}><div><strong>{campaign.name}</strong><br /><span>{campaign.status} · {campaign.targets.length} groups · waits: {intervalSummary(campaign)}</span><br /><span>{scheduleSummary(campaign)}</span>{campaign.status === 'RUNNING' && <p className="run-progress">Current run: <b>{sent} sent</b> · {sending} sending · {waiting} waiting · {failed} failed</p>}</div><div className="row-actions">{campaign.status === 'RUNNING' ? <button onClick={() => void act(`/api/campaigns/${campaign.id}/pause`)}>Pause</button> : <button className="secondary" onClick={() => beginCampaignEdit(campaign)}>Edit</button>}<button onClick={() => void act(`/api/campaigns/${campaign.id}/run-now`)}>Run now</button><button className="secondary" onClick={() => void act(`/api/campaigns/${campaign.id}/stop`)}>Stop</button></div></div>; })}</div><button className="secondary" onClick={() => void act('/api/campaigns/stop-all')}>STOP ALL SENDING</button>
    </section>}
    {message && <p className="success">{message}</p>}{error && <p className="error">{error}</p>}
  </section></main>;
}

createRoot(document.getElementById('root')!).render(<App />);
