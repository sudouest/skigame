export const HUD_STYLES = `
.sg-root {
  position: relative;
  width: 100%;
  height: 100%;
  box-sizing: border-box;
  padding: max(10px, env(safe-area-inset-top)) max(12px, env(safe-area-inset-right))
    max(12px, env(safe-area-inset-bottom)) max(12px, env(safe-area-inset-left));
  font-family: 'Fredoka', 'Nunito', 'Trebuchet MS', 'Segoe UI', system-ui, -apple-system, sans-serif;
  color: #0f172a;
  pointer-events: none;
  touch-action: none;
  user-select: none;
  -webkit-user-select: none;
}

.sg-hidden {
  display: none !important;
}

/* Top HUD Row */
.sg-topbar {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
  width: 100%;
}

.sg-cluster {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.sg-cluster-right {
  justify-content: flex-end;
  flex-direction: column;
  align-items: flex-end;
  gap: 6px;
}

.sg-pill {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  background: rgba(255, 253, 247, 0.94);
  border: 2.5px solid #0f172a;
  border-radius: 16px;
  box-shadow: 0 3px 0 #0f172a;
  padding: 6px 12px;
  line-height: 1.15;
}

.sg-score-card {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 118px;
}

.sg-score-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}

.sg-score-label {
  font-size: 10px;
  font-weight: 800;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: #475569;
}

.sg-score-value {
  font-size: 22px;
  font-weight: 900;
  font-variant-numeric: tabular-nums;
  color: #0f172a;
}

.sg-combo-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 2px 7px;
  border-radius: 999px;
  border: 2px solid #0f172a;
  background: #ffd166;
  font-size: 12px;
  font-weight: 900;
  color: #0f172a;
  transition: transform 0.12s ease, opacity 0.15s ease;
}

.sg-combo-badge.sg-combo-idle {
  opacity: 0.35;
  background: #e2e8f0;
}

.sg-bar-track {
  width: 100%;
  height: 6px;
  background: #e2e8f0;
  border: 1.5px solid #0f172a;
  border-radius: 999px;
  overflow: hidden;
}

.sg-bar-fill {
  height: 100%;
  width: 0%;
  background: linear-gradient(90deg, #f59e0b, #ef476f);
  transition: width 0.06s linear;
}

.sg-bag-card {
  gap: 8px;
}

.sg-bag-card.sg-bag-full {
  background: #fef3c7;
  border-color: #b45309;
}

.sg-bag-icon {
  width: 22px;
  height: 22px;
  flex-shrink: 0;
}

.sg-bag-numbers {
  display: flex;
  flex-direction: column;
}

.sg-bag-count {
  font-size: 16px;
  font-weight: 900;
  font-variant-numeric: tabular-nums;
}

.sg-delivered-sub {
  font-size: 11px;
  font-weight: 700;
  color: #475569;
  font-variant-numeric: tabular-nums;
}

.sg-stage-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.sg-stage-pill {
  font-weight: 800;
  font-size: 13px;
}

.sg-stage-pill[data-stage='icy-black'] {
  background: #0f172a;
  color: #f8fafc;
}

.sg-stage-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: 6px;
  font-size: 12px;
  color: #ffffff;
  border: 2px solid #0f172a;
  flex-shrink: 0;
}

.sg-stage-pill[data-stage='icy-black'] .sg-stage-badge {
  border-color: #38bdf8;
}

.sg-dist-pill {
  font-size: 15px;
  font-weight: 900;
  font-variant-numeric: tabular-nums;
}

/* Action Pill Buttons */
.sg-toggles {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.sg-toggle-btn {
  pointer-events: auto;
  cursor: pointer;
  appearance: none;
  border: 2px solid #0f172a;
  border-radius: 999px;
  background: rgba(255, 253, 247, 0.88);
  box-shadow: 0 2px 0 #0f172a;
  padding: 5px 10px;
  font-family: inherit;
  font-size: 11px;
  font-weight: 800;
  color: #0f172a;
  transition: transform 0.08s ease, background-color 0.12s ease;
}

.sg-toggle-btn:hover {
  background: #ffffff;
}

.sg-toggle-btn:active {
  transform: translateY(2px);
  box-shadow: 0 0 0 #0f172a;
}

.sg-toggle-btn[data-active='true'] {
  background: #38bdf8;
  color: #0f172a;
}

.sg-toggle-btn.sg-btn-snow[data-active='true'] {
  background: #bae6fd;
}

.sg-toggle-btn.sg-btn-debug[data-active='true'] {
  background: #fde047;
}

.sg-toggle-btn.sg-btn-stats[data-active='true'] {
  background: #6ee7b7;
}

/* Center Banners (Fork + Wipeout) */
.sg-center-stack {
  position: absolute;
  top: max(76px, calc(env(safe-area-inset-top) + 64px));
  left: 50%;
  transform: translateX(-50%);
  width: min(440px, calc(100% - 28px));
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  pointer-events: none;
}

.sg-fork-banner {
  width: 100%;
  background: rgba(255, 253, 247, 0.95);
  border: 3px solid #0f172a;
  border-radius: 18px;
  box-shadow: 0 4px 0 #0f172a;
  padding: 8px 12px;
  box-sizing: border-box;
}

.sg-fork-header {
  text-align: center;
  font-size: 12px;
  font-weight: 900;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: #b45309;
  margin-bottom: 6px;
}

.sg-fork-choices {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}

.sg-fork-side {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  padding: 5px 8px;
  border-radius: 10px;
  border: 2px solid #0f172a;
  font-size: 12px;
  font-weight: 800;
  background: #eff6ff;
}

.sg-fork-side[data-stage='icy-black'] {
  background: #1e293b;
  color: #f8fafc;
}

.sg-fork-side-right {
  flex-direction: row-reverse;
}

.sg-wipeout-banner {
  width: min(340px, 100%);
  background: #ef476f;
  color: #ffffff;
  border: 3px solid #0f172a;
  border-radius: 20px;
  box-shadow: 0 4px 0 #0f172a;
  padding: 10px 14px;
  text-align: center;
  box-sizing: border-box;
}

.sg-wipeout-title {
  font-size: 22px;
  font-weight: 900;
  letter-spacing: 0.04em;
  text-shadow: 0 2px 0 #0f172a;
}

.sg-wipeout-sub {
  font-size: 12px;
  font-weight: 700;
  margin: 2px 0 6px;
}

.sg-wipeout-bar {
  height: 7px;
  background: rgba(15, 23, 42, 0.35);
  border: 1.5px solid #0f172a;
  border-radius: 999px;
  overflow: hidden;
}

.sg-wipeout-fill {
  height: 100%;
  width: 0%;
  background: #ffd166;
}

/* Pooled Floating Popups */
.sg-popup-pool {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  width: 100%;
}

.sg-popup {
  padding: 6px 14px;
  border-radius: 14px;
  border: 2.5px solid #0f172a;
  box-shadow: 0 3px 0 #0f172a;
  text-align: center;
  background: #ffffff;
  opacity: 0;
  transform: translateY(8px) scale(0.95);
  transition: opacity 0.16s ease, transform 0.18s ease;
}

.sg-popup.sg-popup-visible {
  opacity: 1;
  transform: translateY(0) scale(1);
}

.sg-popup[data-tone='gift'] {
  background: #ffe4e6;
}

.sg-popup[data-tone='gold'] {
  background: #fef08a;
}

.sg-popup[data-tone='delivery'] {
  background: #bbf7d0;
}

.sg-popup[data-tone='fork'] {
  background: #dbeafe;
}

.sg-popup[data-tone='warning'] {
  background: #fed7aa;
}

.sg-popup[data-tone='stumble'] {
  background: #fde68a;
}

.sg-popup-title {
  font-size: 14px;
  font-weight: 900;
}

.sg-popup-sub {
  font-size: 11px;
  font-weight: 700;
  color: #334155;
}

/* Peripheral Creature Warning Edge Pulses */
.sg-edge-pulse {
  position: absolute;
  top: 20%;
  bottom: 20%;
  width: 14px;
  border-radius: 999px;
  background: rgba(239, 68, 68, 0.72);
  box-shadow: 0 0 18px rgba(239, 68, 68, 0.85);
  opacity: 0;
  transition: opacity 0.18s ease;
}

.sg-edge-left {
  left: max(6px, env(safe-area-inset-left));
}

.sg-edge-right {
  right: max(6px, env(safe-area-inset-right));
}

.sg-edge-pulse.sg-edge-active {
  opacity: 1;
}

/* Bottom Lazy Onboarding Hint */
.sg-hint-pill {
  position: absolute;
  bottom: max(18px, calc(env(safe-area-inset-bottom) + 12px));
  left: 50%;
  transform: translateX(-50%);
  max-width: calc(100% - 28px);
  background: rgba(15, 23, 42, 0.88);
  color: #f8fafc;
  border: 2px solid #ffd166;
  border-radius: 999px;
  padding: 7px 14px;
  font-size: 12px;
  font-weight: 700;
  text-align: center;
  box-shadow: 0 4px 12px rgba(15, 23, 42, 0.35);
}

/* Telemetry Panel */
.sg-telemetry {
  position: absolute;
  top: max(96px, calc(env(safe-area-inset-top) + 86px));
  right: max(12px, env(safe-area-inset-right));
  width: min(292px, calc(100% - 24px));
  background: rgba(15, 23, 42, 0.9);
  color: #e2e8f0;
  border: 2px solid #38bdf8;
  border-radius: 14px;
  padding: 9px 12px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 11px;
  line-height: 1.45;
  box-shadow: 0 6px 20px rgba(15, 23, 42, 0.4);
  font-variant-numeric: tabular-nums;
  box-sizing: border-box;
}

.sg-tele-title {
  font-weight: 800;
  font-size: 11px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: #38bdf8;
  margin-bottom: 4px;
  border-bottom: 1px solid rgba(148, 163, 184, 0.25);
  padding-bottom: 3px;
}

.sg-tele-row {
  display: flex;
  justify-content: space-between;
  gap: 8px;
}

.sg-tele-key {
  color: #94a3b8;
}

.sg-tele-val {
  color: #f8fafc;
  font-weight: 700;
  text-align: right;
}

.sg-tele-val.sg-leak-ok {
  color: #4ade80;
}

.sg-tele-val.sg-leak-bad {
  color: #fb7185;
}

/* Start / Pause / GameOver Modal Overlay */
.sg-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: max(16px, env(safe-area-inset-top)) max(16px, env(safe-area-inset-right))
    max(16px, env(safe-area-inset-bottom)) max(16px, env(safe-area-inset-left));
  background: rgba(15, 23, 42, 0.42);
  backdrop-filter: blur(4px);
  pointer-events: auto;
  box-sizing: border-box;
}

.sg-modal {
  width: min(460px, 100%);
  max-height: 92vh;
  overflow-y: auto;
  background: #fffdf7;
  border: 3.5px solid #0f172a;
  border-radius: 24px;
  box-shadow: 0 8px 0 #0f172a;
  padding: 18px 20px;
  box-sizing: border-box;
}

.sg-modal-kicker {
  display: inline-block;
  padding: 3px 10px;
  border-radius: 999px;
  border: 2px solid #0f172a;
  background: #ffd166;
  font-size: 11px;
  font-weight: 900;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  margin-bottom: 6px;
}

.sg-modal-title {
  margin: 0;
  font-size: 26px;
  font-weight: 900;
  line-height: 1.1;
  color: #0f172a;
}

.sg-modal-sub {
  margin: 4px 0 12px;
  font-size: 13px;
  font-weight: 600;
  color: #475569;
}

.sg-summary-strip {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 6px;
  margin-bottom: 12px;
}

.sg-summary-stat {
  background: #f1f5f9;
  border: 2px solid #0f172a;
  border-radius: 12px;
  padding: 6px 4px;
  text-align: center;
}

.sg-summary-stat-label {
  font-size: 10px;
  font-weight: 800;
  color: #64748b;
  text-transform: uppercase;
}

.sg-summary-stat-val {
  font-size: 14px;
  font-weight: 900;
  font-variant-numeric: tabular-nums;
}

.sg-section-label {
  font-size: 11px;
  font-weight: 900;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: #475569;
  margin-bottom: 6px;
}

.sg-skier-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  margin-bottom: 12px;
}

.sg-skier-card {
  cursor: pointer;
  appearance: none;
  text-align: left;
  font-family: inherit;
  background: #f8fafc;
  border: 2.5px solid #0f172a;
  border-radius: 16px;
  padding: 10px;
  box-shadow: 0 3px 0 #0f172a;
  transition: transform 0.08s ease, background-color 0.12s ease;
}

.sg-skier-card:hover {
  background: #ffffff;
}

.sg-skier-card:active {
  transform: translateY(2px);
  box-shadow: 0 1px 0 #0f172a;
}

.sg-skier-card[data-selected='true'] {
  background: #dbeafe;
  border-color: #1d4ed8;
  box-shadow: 0 3px 0 #1d4ed8;
}

.sg-skier-top {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-bottom: 4px;
}

.sg-skier-swatch {
  width: 16px;
  height: 16px;
  border-radius: 999px;
  border: 2px solid #0f172a;
  flex-shrink: 0;
}

.sg-skier-name {
  font-size: 13px;
  font-weight: 900;
  line-height: 1.15;
  color: #0f172a;
}

.sg-skier-meta {
  font-size: 11px;
  font-weight: 700;
  color: #334155;
}

.sg-skier-perk {
  margin-top: 3px;
  display: inline-block;
  padding: 2px 6px;
  border-radius: 999px;
  background: #fef3c7;
  border: 1.5px solid #0f172a;
  font-size: 10px;
  font-weight: 800;
}

.sg-controls-box {
  background: #f1f5f9;
  border: 2px solid #0f172a;
  border-radius: 14px;
  padding: 9px 11px;
  margin-bottom: 14px;
  font-size: 11.5px;
  line-height: 1.45;
  color: #1e293b;
}

.sg-controls-line {
  margin-bottom: 2px;
}

.sg-controls-line:last-child {
  margin-bottom: 0;
}

.sg-modal-actions {
  display: flex;
  gap: 10px;
}

.sg-cta-btn {
  flex: 1;
  cursor: pointer;
  appearance: none;
  font-family: inherit;
  font-size: 15px;
  font-weight: 900;
  padding: 11px 16px;
  border-radius: 16px;
  border: 2.5px solid #0f172a;
  box-shadow: 0 4px 0 #0f172a;
  transition: transform 0.08s ease;
}

.sg-cta-btn:active {
  transform: translateY(3px);
  box-shadow: 0 1px 0 #0f172a;
}

.sg-cta-primary {
  background: #06d6a0;
  color: #0f172a;
}

.sg-cta-secondary {
  background: #ffd166;
  color: #0f172a;
}

@media (max-width: 640px) {
  .sg-topbar {
    gap: 6px;
  }

  .sg-pill {
    padding: 5px 9px;
    border-radius: 13px;
  }

  .sg-score-card {
    min-width: 96px;
  }

  .sg-score-value {
    font-size: 18px;
  }

  .sg-bag-count {
    font-size: 14px;
  }

  .sg-stage-name {
    display: none;
  }

  .sg-toggle-btn {
    padding: 4px 8px;
    font-size: 10.5px;
  }

  .sg-skier-grid {
    grid-template-columns: 1fr;
  }

  .sg-summary-strip {
    grid-template-columns: repeat(2, 1fr);
  }
}
`;
