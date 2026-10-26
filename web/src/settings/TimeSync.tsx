import { CircleCheck, CircleX, Clock, Info, RefreshCw, TriangleAlert, Tv } from 'lucide-react';
import { t } from '../i18n';
import { CLOCKS, clockLabel, hardwareOf } from '../hardware/model';
import { emptySync, type ClockReference, type HardwareInfo, type ServerConfig } from '../outputs/types';
import { Card } from './ui';
import '../hardware/hardware.css';

/*
 * Settings › Time and sync: the state of the clocks (NTP, PTP) and what
 * the channel clocks follow. PTP itself (domain, card) is set in
 * Hardware › ST 2110, the SDI reference in Hardware › SDI.
 */
export function TimeSync({ cfg, edit, det, onRefresh }: { cfg: ServerConfig; edit: (fn: (c: ServerConfig) => void) => void; det: HardwareInfo | null; onRefresh: () => void }) {
  const sync = { ...emptySync(), ...hardwareOf(structuredClone(cfg)).sync };
  const st = det?.sync;
  const used = new Set(cfg.channels.map((c) => c.clock ?? sync.reference));
  const ntpState = !st || st.ntp.synced == null ? 'unknown' : st.ntp.synced ? 'ok' : 'bad';
  const ptpState = !st ? 'unknown' : st.ptp.locked ? 'ok' : st.ptp.running ? 'bad' : used.has('ptp') ? 'bad' : 'unknown';
  const setReference = (r: ClockReference) =>
    edit((c) => {
      c.hardware = hardwareOf(c);
      c.hardware.sync = { ...emptySync(), ...c.hardware.sync, reference: r };
    });
  return (
    <div className="net-page">
      <Card
        icon={<Clock size={16} />}
        title={t('Status')}
        actions={
          <button className="btn small" onClick={onRefresh}>
            <RefreshCw size={13} /> {t('Refresh')}
          </button>
        }
      >
        <div className="hw-detect">
          <div className={`hw-det-item ${ntpState === 'ok' ? 'ok' : 'warn'}`}>
            {ntpState === 'ok' ? <CircleCheck size={16} /> : ntpState === 'bad' ? <CircleX size={16} /> : <Info size={16} />}
            <div>
              <strong>{ntpState === 'ok' ? t('System clock synchronised (NTP)') : ntpState === 'bad' ? t('System clock not synchronised (NTP)') : t('NTP status unknown')}</strong>
              <span>{[st?.ntp.source && t('source {source}', { source: st.ntp.source }), st?.ntp.offsetMs != null && t('offset {ms} ms', { ms: st.ntp.offsetMs.toFixed(3) }), st?.ntp.tool && t('read with {tool}', { tool: st.ntp.tool })].filter(Boolean).join(' · ') || '—'}</span>
            </div>
          </div>
          <div className={`hw-det-item ${ptpState === 'ok' ? 'ok' : 'warn'}`}>
            {ptpState === 'ok' ? <CircleCheck size={16} /> : ptpState === 'bad' ? <CircleX size={16} /> : <Info size={16} />}
            <div>
              <strong>{st?.ptp.locked ? t('Locked to PTP (domain {domain})', { domain: st.ptp.domain }) : st?.ptp.running ? t('PTP not locked ({state})', { state: st.ptp.portState ?? '?' }) : t('No PTP')}</strong>
              <span>
                {st?.ptp.running
                  ? [st.ptp.grandmaster && t('grandmaster {id}', { id: st.ptp.grandmaster }), st.ptp.offsetNs != null && t('offset {ns} ns', { ns: Math.round(st.ptp.offsetNs) })].filter(Boolean).join(' · ')
                  : st?.ptp.message
                    ? t(st.ptp.message)
                    : t('Detecting…')}
              </span>
            </div>
          </div>
        </div>
      </Card>

      <Card icon={<Clock size={16} />} title={t('Clock reference')}>
        <div className="seg hw-clock-seg">
          {CLOCKS.map((r) => (
            <button key={r} type="button" className={sync.reference === r ? 'on' : ''} onClick={() => setReference(r)}>
              {clockLabel(r)}
            </button>
          ))}
        </div>
      </Card>

      <Card icon={<Tv size={16} />} title={t('Channels')}>
        <div className="hw-table">
          {cfg.channels.map((ch) => {
            const sdi = [ch.outputs, ...(ch.renditions ?? []).map((r) => r.outputs)].some((o) => (o.sdi ?? []).some((d) => d.enabled !== false));
            const ref = ch.clock ?? sync.reference;
            return (
              <div key={ch.id} className="hw-row sync">
                <strong>{ch.name}</strong>
                <span>
                  {ref === 'decklink' && !sdi && (
                    <span className="hw-note warn">
                      <TriangleAlert size={13} /> {t('no SDI destination: runs free')}
                    </span>
                  )}
                </span>
                <select
                  value={ch.clock ?? ''}
                  aria-label={t('Clock reference')}
                  onChange={(e) =>
                    edit((all) => {
                      const c = all.channels.find((x) => x.id === ch.id)!;
                      c.clock = (e.target.value || null) as ClockReference | null;
                    })
                  }
                >
                  <option value="">{t('Default ({reference})', { reference: clockLabel(sync.reference) })}</option>
                  {CLOCKS.map((r) => (
                    <option key={r} value={r}>
                      {clockLabel(r)}
                    </option>
                  ))}
                </select>
              </div>
            );
          })}
        </div>
      </Card>
    </div>
  );
}
