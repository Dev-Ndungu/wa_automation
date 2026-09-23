import { useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

// The built dashboard is served same-origin by the local API (default port
// 3001), so API calls go back to the page's own origin there. In development
// the Vite server (fixed port 5173) serves the dashboard and does not proxy
// the API, so that case must keep calling the API on its own port directly.
const api = window.location.port === '5173' ? 'http://127.0.0.1:3001' : (window.location.origin || 'http://127.0.0.1:3001');
type Status = { state: string; phone: string | null; lastConnectedAt: string | null; qrDataUrl: string | null; error: string | null; warning: string | null };
type Account = { id: string; name: string; phone: string | null; status: Status };
type Group = { whatsappGroupJid: string; name: string; isScannerEnabled: boolean; isExcluded: boolean };
type Link = { id: string; inviteUrl: string; sourceGroupName: string; firstSeenAt: string; timesSeen: number; status: string };
type CampaignTarget = { groupJid: string; groupName: string; status: 'QUEUED' | 'WAITING' | 'SENDING' | 'SENT' | 'FAILED' | 'CANCELLED'; sentAt?: string | null; errorMessage?: string | null };
type Campaign = { id: string; name: string; status: string; targets: CampaignTarget[]; sourceMessageReference: string; sources?: Array<{ id: string; kind: 'text'|'image'|'video'; preview: string }> | null; sourceContent?: { text: string; hasImage: boolean } | null; scheduleConfig?: string; nextRunAt?: string | null; autoAddJoinedGroups?: boolean; shuffleOrder?: boolean; pauseReason?: string | null; autoResumeAt?: string | null };

async function apiRequest(path: string, init?: RequestInit, accountId?: string | null) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let response: Response;
    try {
      const headers = new Headers(init?.headers);
      if (accountId) headers.set('x-whatsapp-account-id', accountId);
      response = await fetch(`${api}${path}`, { ...init, headers });
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

function attachmentSummary(campaign: Campaign) {
  const media = campaign.sources ? campaign.sources.filter((source) => source.kind !== 'text') : null;
  if (media && media.length > 0) {
    const images = media.filter((source) => source.kind === 'image').length;
    const videos = media.length - images;
    if (media.length === 1) return images === 1 ? '1 image' : '1 video';
    const parts: string[] = [];
    if (images > 0) parts.push(`${images} image${images === 1 ? '' : 's'}`);
    if (videos > 0) parts.push(`${videos} video${videos === 1 ? '' : 's'}`);
    return `${media.length} files (${parts.join(', ')})`;
  }
  return campaign.sourceContent?.hasImage ? '1 image' : 'text';
}

const mediaKindsOf = (c: Campaign) => (c.sources ? c.sources.filter((source) => source.kind !== 'text').map((source) => source.kind) : c.sourceContent?.hasImage ? ['image'] : []);

let mediaFileKey = 0;

function App() {
  const [page, setPage] = useState<'home' | 'groups' | 'links' | 'campaigns'>('home');
  const [status, setStatus] = useState<Status | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [activeAccountId, setActiveAccountId] = useState<string | null>(() => { try { return window.localStorage.getItem('wa-control-active-account'); } catch { return null; } });
  const [newAccountName, setNewAccountName] = useState('');
  const [groups, setGroups] = useState<Group[]>([]);
  const [links, setLinks] = useState<Link[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [source, setSource] = useState('');
  const [mediaFiles, setMediaFiles] = useState<Array<{ key: number; kind: 'image' | 'video'; dataUrl: string; name: string; size: number }>>([]);
  const [imageInputKey, setImageInputKey] = useState(0);
  const [campaignName, setCampaignName] = useState('');
  const [selectedGroupJids, setSelectedGroupJids] = useState<string[]>([]);
  const [scheduleType, setScheduleType] = useState<'ONCE' | 'MINUTELY' | 'HOURLY' | 'DAILY' | 'EVERY_N_DAYS' | 'WEEKLY'>('ONCE');
  const [scheduleTime, setScheduleTime] = useState('17:00');
  const [intervalHours, setIntervalHours] = useState('1');
  const [intervalMinutes, setIntervalMinutes] = useState('15');
  const [intervalDays, setIntervalDays] = useState('3');
  const [weekdays, setWeekdays] = useState<number[]>([1]);
  const [groupSearch, setGroupSearch] = useState('');
  const [groupListMode, setGroupListMode] = useState<'all' | 'new'>('all');
  const [originalCampaignGroupJids, setOriginalCampaignGroupJids] = useState<string[]>([]);
  const [linkGroupJids, setLinkGroupJids] = useState<string[]>([]);
  const [lookbackValue, setLookbackValue] = useState('24');
  const [lookbackUnit, setLookbackUnit] = useState<'hours' | 'days'>('hours');
  const [appliedLinkFilters, setAppliedLinkFilters] = useState({ groupJids: [] as string[], lookbackHours: 24 });
  const [groupInviteLinks, setGroupInviteLinks] = useState<Record<string, string>>({});
  const [editingCampaign, setEditingCampaign] = useState<Campaign | null>(null);
  const [editingSourceText, setEditingSourceText] = useState('');
  const [originalMediaKinds, setOriginalMediaKinds] = useState<string[]>([]);
  const [removedOriginalMedia, setRemovedOriginalMedia] = useState(false);
  const [autoAddJoinedGroups, setAutoAddJoinedGroups] = useState(false);
  const [shuffleOrder, setShuffleOrder] = useState(true);

  const request = useCallback((path: string, init?: RequestInit) => apiRequest(path, init, activeAccountId), [activeAccountId]);

  const refresh = useCallback(async () => {
    try {
      const nextAccounts = await apiRequest('/api/accounts') as Account[];
      setAccounts(nextAccounts);
      const selectedAccount = nextAccounts.find((account) => account.id === activeAccountId) ?? nextAccounts[0];
      if (!selectedAccount) throw new Error('No WhatsApp account is available.');
      if (selectedAccount.id !== activeAccountId) {
        setActiveAccountId(selectedAccount.id);
        // Storage can be blocked (private mode, hardened browsers) — the
        // account selection must still apply and must never kill the refresh.
        try { window.localStorage.setItem('wa-control-active-account', selectedAccount.id); } catch { /* Session-only selection. */ }
      }
      const linkQuery = new URLSearchParams({ limit: '100' });
      if (appliedLinkFilters.groupJids.length) linkQuery.set('groupJids', appliedLinkFilters.groupJids.join(','));
      if (appliedLinkFilters.lookbackHours > 0) linkQuery.set('lookbackHours', String(appliedLinkFilters.lookbackHours));
      const [nextStatus, nextGroups, nextLinks, nextCampaigns] = await Promise.all([
        apiRequest('/api/whatsapp/status', undefined, selectedAccount.id), apiRequest('/api/groups', undefined, selectedAccount.id), apiRequest(`/api/links?${linkQuery}`, undefined, selectedAccount.id), apiRequest('/api/campaigns', undefined, selectedAccount.id),
      ]);
      setStatus(nextStatus); setGroups(nextGroups); setLinks(nextLinks.items); setCampaigns(nextCampaigns);
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Local API unavailable.');
    }
  }, [activeAccountId, appliedLinkFilters]);

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

  function selectAccount(accountId: string) {
    setActiveAccountId(accountId);
    try { window.localStorage.setItem('wa-control-active-account', accountId); } catch { /* Session-only selection. */ }
    clearCampaignForm();
    setGroupInviteLinks({});
    setMessage('Switched WhatsApp account.');
  }

  async function addAccount() {
    if (!newAccountName.trim()) { setError('Enter a name for the new WhatsApp account.'); return; }
    try {
      const created = await apiRequest('/api/accounts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: newAccountName }) }) as Account;
      setNewAccountName('');
      setActiveAccountId(created.id);
      try { window.localStorage.setItem('wa-control-active-account', created.id); } catch { /* Session-only selection. */ }
      setMessage(`“${created.name}” was added. Link its WhatsApp account from Home.`);
      await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not add WhatsApp account.'); }
  }

  function toggleCampaignGroup(jid: string) {
    setSelectedGroupJids((selected) => selected.includes(jid) ? selected.filter((selectedJid) => selectedJid !== jid) : [...selected, jid]);
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

  async function addMediaFiles(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return;
    const pending: Array<{ file: File; kind: 'image' | 'video' }> = [];
    for (const file of Array.from(fileList)) {
      const isImage = ['image/png', 'image/jpeg', 'image/webp'].includes(file.type);
      const isVideo = file.type === 'video/mp4' || file.name.toLowerCase().endsWith('.mp4');
      if (!isImage && !isVideo) { setError('Only PNG, JPEG, WebP images and MP4 videos are supported.'); continue; }
      if (isImage && file.size > 4 * 1024 * 1024) { setError('Choose an image smaller than 4 MB.'); continue; }
      if (isVideo && file.size > 16 * 1024 * 1024) { setError('Choose a video smaller than 16 MB.'); continue; }
      if (mediaFiles.length + pending.length >= 10) { setError('A campaign can contain at most 10 files.'); break; }
      pending.push({ file, kind: isVideo ? 'video' : 'image' });
    }
    if (pending.length === 0) return;
    const reads = pending.map(({ file, kind }, index) => new Promise<{ key: number; kind: 'image' | 'video'; dataUrl: string; name: string; size: number } | null>((resolve) => {
      const reader = new FileReader();
      reader.onerror = () => { setError('Could not read that file.'); resolve(null); };
      reader.onload = () => resolve({ key: mediaFileKey + index, kind, dataUrl: String(reader.result), name: file.name, size: file.size });
      reader.readAsDataURL(file);
    }));
    mediaFileKey += pending.length;
    const added = (await Promise.all(reads)).filter((result): result is { key: number; kind: 'image' | 'video'; dataUrl: string; name: string; size: number } => result !== null);
    setMediaFiles((current) => [...current, ...added]);
    setImageInputKey((key) => key + 1);
  }

  async function createCampaign(startAfterCreate = false) {
    if ((!source.trim() && mediaFiles.length === 0) || !campaignName.trim()) { setError('Enter a campaign name and source message.'); return; }
    if (selectedGroupJids.length === 0) { setError('Select at least one group for this campaign.'); return; }
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
    const saved = await act('/api/campaigns/source-messages/manual', { text: source, label: campaignName, files: mediaFiles.map(({ kind, dataUrl, name }) => ({ kind, dataUrl, name })) });
    if (!saved) return;
    const campaign = await act('/api/campaigns', {
      name: campaignName, sourceMessageIds: saved.sources.map((s: { id: string }) => s.id), groupJids: selectedGroupJids, schedule, autoAddJoinedGroups, shuffleOrder,
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
    setSource(''); setMediaFiles([]); setImageInputKey((key) => key + 1); setCampaignName(''); setSelectedGroupJids([]); setScheduleType('ONCE');
    setEditingCampaign(null); setEditingSourceText(''); setOriginalMediaKinds([]); setRemovedOriginalMedia(false); setAutoAddJoinedGroups(false); setShuffleOrder(true); setGroupListMode('all'); setOriginalCampaignGroupJids([]);
  }

  async function beginCampaignEdit(campaign: Campaign) {
    let latestGroups = groups;
    if (connected) {
      try {
        await request('/api/whatsapp/sync-groups', { method: 'POST' });
        latestGroups = await request('/api/groups') as Group[];
        setGroups(latestGroups);
      } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not refresh groups before editing.'); return; }
    }
    let schedule: Record<string, unknown> = { type: 'ONCE' };
    try { schedule = JSON.parse(campaign.scheduleConfig ?? '{"type":"ONCE"}'); } catch { /* Keep the safe one-time default. */ }
    setEditingCampaign(campaign); setCampaignName(campaign.name); setSource(campaign.sourceContent?.text ?? ''); setEditingSourceText(campaign.sourceContent?.text ?? '');
    setOriginalMediaKinds(mediaKindsOf(campaign)); setRemovedOriginalMedia(false); setMediaFiles([]); setImageInputKey((key) => key + 1);
    const eligibleGroupJids = new Set(latestGroups.filter((group) => !group.isExcluded).map((group) => group.whatsappGroupJid));
    const editableTargets = campaign.targets.map((target) => target.groupJid).filter((jid) => eligibleGroupJids.has(jid));
    const excludedTargetCount = campaign.targets.length - editableTargets.length;
    setSelectedGroupJids(editableTargets); setOriginalCampaignGroupJids(campaign.targets.map((target) => target.groupJid)); setGroupListMode('all');
    setScheduleType((schedule.type as typeof scheduleType) ?? 'ONCE');
    setIntervalMinutes(String(schedule.intervalMinutes ?? 15)); setIntervalHours(String(schedule.intervalHours ?? 1)); setIntervalDays(String(schedule.intervalDays ?? 3));
    setScheduleTime(typeof schedule.time === 'string' ? schedule.time : '17:00'); setWeekdays(Array.isArray(schedule.weekdays) ? schedule.weekdays as number[] : [1]);
    setAutoAddJoinedGroups(Boolean(campaign.autoAddJoinedGroups)); setShuffleOrder(campaign.shuffleOrder ?? true);
    setMessage(excludedTargetCount > 0
      ? `Editing “${campaign.name}”. ${excludedTargetCount} excluded group(s) were removed from this campaign.`
      : campaign.status === 'RUNNING' ? `Editing “${campaign.name}” while it runs. Sent and in-progress groups will be kept.` : `Editing “${campaign.name}”. Save changes when ready.`);
  }

  async function saveCampaignEdit() {
    if (!editingCampaign) return;
    if (!source.trim() || !campaignName.trim() || selectedGroupJids.length === 0) { setError('Enter a campaign name, message, and at least one group.'); return; }
    const schedule = scheduleType === 'ONCE' ? { type: 'ONCE' }
      : scheduleType === 'MINUTELY' ? { type: 'MINUTELY', intervalMinutes: Number(intervalMinutes) }
      : scheduleType === 'HOURLY' ? { type: 'HOURLY', intervalHours: Number(intervalHours) }
      : scheduleType === 'DAILY' ? { type: 'DAILY', time: scheduleTime }
      : scheduleType === 'EVERY_N_DAYS' ? { type: 'EVERY_N_DAYS', intervalDays: Number(intervalDays), time: scheduleTime }
      : { type: 'WEEKLY', weekdays, time: scheduleTime };
    const currentMediaKinds = mediaFiles.map((file) => file.kind);
    const filesChanged = removedOriginalMedia || currentMediaKinds.length > 0;
    let sourceMessageIds: string[];
    if (source !== editingSourceText || filesChanged) {
      const originalMediaSourceIds = editingCampaign.sources ? editingCampaign.sources.filter((s) => s.kind !== 'text').map((s) => s.id) : [];
      const newFiles = mediaFiles.map(({ kind, dataUrl, name }) => ({ kind, dataUrl, name }));
      let payload: Record<string, unknown>;
      if (!filesChanged && originalMediaSourceIds.length > 0) {
        // Text-only change with original media kept: refresh captions in place.
        payload = { text: source, label: campaignName, updateSourceIds: originalMediaSourceIds };
      } else if (newFiles.length > 0 && !removedOriginalMedia && originalMediaSourceIds.length > 0) {
        // New files added, original media kept: refresh originals AND capture new.
        payload = { text: source, label: campaignName, updateSourceIds: originalMediaSourceIds, files: newFiles };
      } else if (newFiles.length > 0) {
        // Original media removed, new files added: capture fresh.
        payload = { text: source, label: campaignName, files: newFiles };
      } else {
        // Original media removed, no new files: legacy text capture (text is guaranteed non-empty).
        payload = { text: source, label: campaignName };
      }
      const saved = await act('/api/campaigns/source-messages/manual', payload);
      if (!saved) return;
      sourceMessageIds = saved.sources.map((s: { id: string }) => s.id);
    } else {
      sourceMessageIds = editingCampaign.sources ? editingCampaign.sources.map((s) => s.id) : [editingCampaign.sourceMessageReference];
    }
    try {
      await request(`/api/campaigns/${editingCampaign.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: campaignName, sourceMessageIds, groupJids: selectedGroupJids, schedule, autoAddJoinedGroups, shuffleOrder }) });
      setMessage('Campaign changes saved.'); clearCampaignForm(); await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not save campaign changes.'); }
  }

  const connected = status?.state === 'CONNECTED';
  const campaignGroups = groups.filter((group) => !group.isExcluded);
  const newCampaignGroups = campaignGroups.filter((group) => !originalCampaignGroupJids.includes(group.whatsappGroupJid));
  const shownGroups = (groupListMode === 'new' ? newCampaignGroups : campaignGroups).filter((group) => `${group.name} ${group.whatsappGroupJid}`.toLowerCase().includes(groupSearch.trim().toLowerCase()));
  return <main><section className="card wide">
    <header><div><p className="eyebrow">LOCAL DASHBOARD</p><h1>WhatsApp Group Control</h1></div><div className="account-controls"><label>WhatsApp account<select value={activeAccountId ?? ''} onChange={(event) => selectAccount(event.target.value)}>{accounts.map((account) => <option key={account.id} value={account.id}>{account.name}{account.phone ? ` · ${account.phone}` : ''}</option>)}</select></label><input placeholder="New account name" value={newAccountName} onChange={(event) => setNewAccountName(event.target.value)} /><button className="secondary" onClick={() => void addAccount()}>Add account</button><span className={`badge ${connected ? 'ok' : ''}`}>{status?.state ?? 'LOADING'}</span></div></header>
    <nav>{(['home', 'groups', 'links', 'campaigns'] as const).map((item) => <button key={item} className={page === item ? '' : 'secondary'} onClick={() => setPage(item)}>{item[0].toUpperCase() + item.slice(1)}</button>)}</nav>
    {page === 'campaigns' && <p className="hint">Campaign messages are sent only from 06:00 to 23:00 East Africa Time. Messages waiting at night continue after 06:00. The daily send cap (50 messages) pauses a campaign for the rest of the day and it resumes itself when the cap resets at UTC midnight — no manual resume needed.</p>}
    {status?.warning && <p className="warning-banner" role="alert">{status.warning}</p>}
    {page === 'home' &&<section className="panel"><h2>WhatsApp connection</h2><p>{connected ? `Linked phone: ${status?.phone}${status?.lastConnectedAt ? ` · linked since ${new Date(status.lastConnectedAt).toLocaleString()}` : ''}` : status?.state === 'QR_READY' ? 'Scan this QR code in WhatsApp to link this device.' : status?.state === 'CONNECTING' ? 'Connecting to WhatsApp…' : 'Not linked'}</p>{!connected && status?.error && <p className="error">{status.error}</p>}{status?.qrDataUrl && <div className="qr-panel"><img src={status.qrDataUrl} alt="WhatsApp linking QR code" /><p>WhatsApp → Settings → Linked devices → Link a device</p></div>}{connected ? <><button onClick={() => void act('/api/whatsapp/sync-groups')}>Refresh groups</button><button className="secondary" onClick={() => void act('/api/whatsapp/disconnect')}>Disconnect</button></> : <button onClick={() => void act('/api/whatsapp/link')}>{status?.state === 'QR_READY' ? 'Generate a new QR code' : 'Link WhatsApp'}</button>}<p>Scanner is running locally. It only records group invite links; it never joins groups or sends anything automatically. Sends and joins are paced between safe random limits.</p></section>}
    {page === 'groups' && <section className="panel"><h2>Groups ({groups.length})</h2><p>Excluded groups are neither scanned nor available for campaigns. You can also retrieve each group’s current WhatsApp invite link here.</p><div className="list">{groups.map((group) => <div className="row" key={group.whatsappGroupJid}><div><strong>{group.name}</strong>{group.isExcluded && <span className="muted"> · Excluded</span>}{groupInviteLinks[group.whatsappGroupJid] && <><br /><a href={groupInviteLinks[group.whatsappGroupJid]} target="_blank" rel="noreferrer">Open WhatsApp group link</a></>}</div><div className="row-actions"><label><input type="checkbox" checked={group.isScannerEnabled} disabled={group.isExcluded} onChange={(event) => void updateGroup(group, { isScannerEnabled: event.target.checked })} /> Scan</label><label><input type="checkbox" checked={group.isExcluded} onChange={(event) => void updateGroup(group, { isExcluded: event.target.checked })} /> Exclude</label><button className="secondary" onClick={() => void showGroupInviteLink(group)}>Get WhatsApp link</button></div></div>)}</div></section>}
    {page === 'links' && <section className="panel"><h2>Saved link history</h2><p>{links.length} matching links. Groups are only joined when you press Join group on a saved link — the scanner never joins automatically.</p><div className="history-filter"><label>Look back<input type="number" min="1" value={lookbackValue} onChange={(event) => setLookbackValue(event.target.value)} /></label><select value={lookbackUnit} onChange={(event) => setLookbackUnit(event.target.value as 'hours' | 'days')}><option value="hours">hours</option><option value="days">days</option></select><button onClick={applyLookback}>Look back now</button></div><details><summary>Select source groups to include</summary>{groups.filter((group) => !group.isExcluded).map((group) => <label className="daily-toggle" key={group.whatsappGroupJid}><input type="checkbox" checked={linkGroupJids.includes(group.whatsappGroupJid)} onChange={() => setLinkGroupJids((current) => current.includes(group.whatsappGroupJid) ? current.filter((jid) => jid !== group.whatsappGroupJid) : [...current, group.whatsappGroupJid])} /> {group.name}</label>)}</details><div className="list">{links.map((link) => <div className="row" key={link.id}><div><strong>{link.sourceGroupName}</strong><br /><a href={link.inviteUrl} target="_blank" rel="noreferrer">Open link</a><br />Found {new Date(link.firstSeenAt).toLocaleString()} · Seen {link.timesSeen} times</div><button className="secondary" onClick={() => void navigator.clipboard.writeText(link.inviteUrl)}>Copy</button><button onClick={() => { if (window.confirm(`Join the group from this invite link?\n\n${link.inviteUrl}`)) void act(`/api/links/${link.id}/join`).then((result) => { if (result) setMessage('Joined group and removed the link from this list.'); }); }}>Join group</button><select value={link.status} onChange={(event) => void request(`/api/links/${link.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: event.target.value }) }).then(refresh)}><option>NEW</option><option>VIEWED</option><option>USED</option><option>ARCHIVED</option></select></div>)}</div><a className="download" href={`${api}/api/links/export.csv`}>Download CSV</a></section>}
    {page === 'campaigns' && <section className="panel"><h2>{editingCampaign ? `Edit campaign: ${editingCampaign.name}` : 'New campaign'}</h2><p>Scheduling decides when a campaign begins. Sends and group joins are paced automatically between safe random limits — there are no manual pacing settings to get wrong. Live progress refreshes safely every few seconds.</p>{editingCampaign && <button className="secondary" onClick={clearCampaignForm}>Cancel edit</button>}<input placeholder="Campaign name" value={campaignName} onChange={(event) => setCampaignName(event.target.value)} /><textarea placeholder="Message or image caption" value={source} onChange={(event) => setSource(event.target.value)} /><input key={imageInputKey} type="file" multiple accept="image/png,image/jpeg,image/webp,video/mp4" onChange={(event) => { void addMediaFiles(event.target.files); event.target.value = ''; }} />{mediaFiles.length > 0 && <div className="list">{mediaFiles.map((file) => <div className="row" key={file.key}>{file.kind === 'image' ? <div className="image-preview"><img src={file.dataUrl} alt={file.name} /></div> : <div><span className="muted">{file.name}</span> <span className="badge">{(file.size / 1e6).toFixed(1)} MB video</span></div>}<button className="secondary" onClick={() => setMediaFiles((current) => current.filter((entry) => entry.key !== file.key))}>× Remove</button></div>)}</div>}{editingCampaign && originalMediaKinds.length > 0 && mediaFiles.length === 0 && !removedOriginalMedia && <div className="image-preview"><span>Existing attachments ({originalMediaKinds.length} file(s)) will be kept.</span><button className="secondary" onClick={() => setRemovedOriginalMedia(true)}>× Remove attachments</button></div>}
      <h3>Recipient groups ({selectedGroupJids.length} / {campaignGroups.length})</h3><p className="hint">When editing, show only groups not already included in this campaign to add new groups quickly.</p><input placeholder="Search groups" value={groupSearch} onChange={(event) => setGroupSearch(event.target.value)} /><div className="selection-actions"><button className="secondary" onClick={() => void request('/api/whatsapp/sync-groups', { method: 'POST' }).then(refresh).catch((cause) => setError(cause instanceof Error ? cause.message : 'Could not refresh groups.'))}>Refresh available groups</button>{editingCampaign && <button className={groupListMode === 'new' ? '' : 'secondary'} onClick={() => setGroupListMode((mode) => mode === 'new' ? 'all' : 'new')}>{groupListMode === 'new' ? 'Show all groups' : `New groups (${newCampaignGroups.length})`}</button>}<button className="secondary" onClick={() => setSelectedGroupJids((current) => [...new Set([...current, ...shownGroups.map((group) => group.whatsappGroupJid)])])}>Select shown</button><button className="secondary" onClick={() => setSelectedGroupJids(campaignGroups.map((group) => group.whatsappGroupJid))}>Select all</button><button className="secondary" onClick={() => setSelectedGroupJids([])}>Clear selection</button></div><div className="list target-list">{shownGroups.map((group) => <label className="row selectable" key={group.whatsappGroupJid}><input type="checkbox" checked={selectedGroupJids.includes(group.whatsappGroupJid)} onChange={() => toggleCampaignGroup(group.whatsappGroupJid)} /><strong>{group.name}</strong></label>)}{groupListMode === 'new' && shownGroups.length === 0 && <p className="hint">No new groups are available for this campaign.</p>}</div>
      <h3>When should this campaign run?</h3><select value={scheduleType} onChange={(event) => setScheduleType(event.target.value as typeof scheduleType)}><option value="ONCE">Run once, when I press Start</option><option value="MINUTELY">Repeat every number of minutes</option><option value="HOURLY">Repeat every number of hours</option><option value="DAILY">Run every day at a time</option><option value="EVERY_N_DAYS">Run every number of days</option><option value="WEEKLY">Run weekly on selected days</option></select>{scheduleType === 'MINUTELY' && <label className="time-input">Repeat every (minutes)<input type="number" min="1" max="10080" step="1" value={intervalMinutes} onChange={(event) => setIntervalMinutes(event.target.value)} /></label>}{scheduleType === 'HOURLY' && <label className="time-input">Repeat every (hours)<input type="number" min="1" max="168" step="1" value={intervalHours} onChange={(event) => setIntervalHours(event.target.value)} /></label>}{['DAILY', 'EVERY_N_DAYS', 'WEEKLY'].includes(scheduleType) && <label className="time-input">Start time (24-hour clock)<input type="time" value={scheduleTime} onChange={(event) => setScheduleTime(event.target.value)} /></label>}{scheduleType === 'EVERY_N_DAYS' && <label className="time-input">Repeat every (days)<input type="number" min="2" max="365" step="1" value={intervalDays} onChange={(event) => setIntervalDays(event.target.value)} /></label>}{scheduleType === 'WEEKLY' && <div className="weekdays">{['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((name, day) => <label key={name}><input type="checkbox" checked={weekdays.includes(day)} onChange={() => toggleWeekday(day)} /> {name}</label>)}</div>}
      <label className="daily-toggle"><input type="checkbox" checked={autoAddJoinedGroups} onChange={(event) => setAutoAddJoinedGroups(event.target.checked)} /> Automatically add newly joined groups to this campaign</label><p className="hint">Groups joined through Links while this campaign is active will be added to its remaining recipients.</p><label className="daily-toggle"><input type="checkbox" checked={shuffleOrder} onChange={(event) => setShuffleOrder(event.target.checked)} /> Shuffle recipient order each run</label><p className="hint">Recipients are picked in a random order each run while files always keep their order.</p>{editingCampaign ? <button onClick={() => void saveCampaignEdit()}>{editingCampaign.status === 'RUNNING' ? 'Save live changes' : 'Save campaign changes'}</button> : <><button onClick={() => void createCampaign()}>Create campaign</button>{selectedGroupJids.length > 0 && <button onClick={() => void createCampaign(true)}>Create and start campaign</button>}</>}
      <h2>Campaign history</h2><div className="list">{campaigns.map((campaign) => { const sent = campaign.targets.filter((target) => target.status === 'SENT').length; const sending = campaign.targets.filter((target) => target.status === 'SENDING').length; const failed = campaign.targets.filter((target) => target.status === 'FAILED').length; const waiting = campaign.targets.length - sent - failed - sending; return <div className="row campaign-row" key={campaign.id}><div><strong>{campaign.name}</strong><br /><span>{campaign.status} · {campaign.targets.length} groups</span><br /><span>{attachmentSummary(campaign)}</span><br /><span>{scheduleSummary(campaign)}</span>{campaign.autoAddJoinedGroups && <p className="hint">Newly joined groups are added automatically.</p>}{campaign.pauseReason && <p className="hint">{campaign.pauseReason}</p>}{campaign.autoResumeAt && <p className="hint">Resumes automatically at {new Date(campaign.autoResumeAt).toLocaleString()}.</p>}{campaign.status === 'RUNNING' && <p className="run-progress">Current run: <b>{sent} sent</b> · {sending} sending · {waiting} waiting · {failed} failed</p>}</div><div className="row-actions"><button className="secondary" onClick={() => void beginCampaignEdit(campaign)}>Edit</button>{campaign.status === 'RUNNING' && <button onClick={() => void act(`/api/campaigns/${campaign.id}/pause`)}>Pause</button>}<button onClick={() => void act(`/api/campaigns/${campaign.id}/run-now`)}>Run now</button><button className="secondary" onClick={() => void act(`/api/campaigns/${campaign.id}/stop`)}>Stop</button><button className="secondary" onClick={() => { if (window.confirm(`Delete campaign "${campaign.name}"? This cannot be undone.`)) { void request(`/api/campaigns/${campaign.id}`, { method: 'DELETE' }).then(() => { setMessage('Campaign deleted.'); if (editingCampaign?.id === campaign.id) clearCampaignForm(); void refresh(); }).catch((cause) => setError(cause instanceof Error ? cause.message : 'Could not delete campaign.')); } }}>Delete</button></div></div>; })}</div><button className="secondary" onClick={() => void act('/api/campaigns/stop-all')}>STOP ALL SENDING</button>
    </section>}
    {message && <p className="success">{message}</p>}{error && <p className="error">{error}</p>}
  </section></main>;
}

createRoot(document.getElementById('root')!).render(<App />);
