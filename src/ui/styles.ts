export const HUD_STYLES = `
.sg-root {
  --sg-font-ui: 'Plus Jakarta Sans', 'Inter', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  --sg-font-display: 'Barlow Condensed', 'DIN Condensed', 'Avenir Next Condensed', 'Arial Narrow', 'Plus Jakarta Sans', system-ui, sans-serif;
  --sg-font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  --sg-frost: rgba(12, 24, 44, 0.68);
  --sg-frost-strong: rgba(10, 20, 38, 0.84);
  --sg-frost-elevated: rgba(16, 31, 56, 0.78);
  --sg-border-ice: rgba(224, 242, 254, 0.24);
  --sg-border-ice-strong: rgba(224, 242, 254, 0.42);
  --sg-shadow-pill: 0 6px 20px rgba(5, 14, 30, 0.3), inset 0 1px 0 rgba(255, 255, 255, 0.24);
  --sg-shadow-modal: 0 24px 60px rgba(4, 11, 24, 0.56), inset 0 1px 0 rgba(255, 255, 255, 0.24);
  --sg-text-snow: #f8fafc;
  --sg-text-mist: #cbd5e1;
  --sg-text-muted: #94a3b8;
  --sg-accent-gift: #ff4d6d;
  --sg-accent-gold: #fbbf24;
  --sg-accent-aurora: #34d399;
  --sg-accent-ice: #38bdf8;
  --sg-accent-alert: #fb7185;
  --sg-accent-amber: #f97316;

  position: relative;
  width: 100%;
  height: 100%;
  box-sizing: border-box;
  padding: max(10px, env(safe-area-inset-top)) max(12px, env(safe-area-inset-right))
    max(12px, env(safe-area-inset-bottom)) max(12px, env(safe-area-inset-left));
  font-family: var(--sg-font-ui);
  color: var(--sg-text-snow);
  pointer-events: none;
  touch-action: none;
  user-select: none;
  -webkit-user-select: none;
  overflow: hidden;
}

@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
  .sg-root {
    --sg-frost: rgba(12, 24, 44, 0.88);
    --sg-frost-strong: rgba(10, 20, 38, 0.94);
    --sg-frost-elevated: rgba(16, 31, 56, 0.92);
  }
}

.sg-hidden {
  display: none !important;
}

/* Subtle Stumble Peripheral Flash */
.sg-stumble-flash {
  position: absolute;
  inset: 0;
  pointer-events: none;
  opacity: 0;
  box-shadow: inset 0 0 64px rgba(249, 115, 22, 0.65);
  transition: opacity 0.16s ease;
}

.sg-stumble-flash.sg-stumble-active {
  opacity: 1;
}

/* Top Bar Layout */
.sg-topbar {
  position: relative;
  z-index: 4;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
}

.sg-cluster-left {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
  min-width: 0;
}

.sg-cluster-right {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 6px;
  flex-shrink: 0;
}

/* Shared Frosted Glass Capsule */
.sg-hud-capsule {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 10px;
  background: linear-gradient(180deg, rgba(240, 248, 255, 0.13) 0%, rgba(12, 24, 44, 0) 62%),
    var(--sg-frost);
  backdrop-filter: blur(10px) saturate(140%);
  -webkit-backdrop-filter: blur(10px) saturate(140%);
  border: 1px solid var(--sg-border-ice);
  border-radius: 999px;
  box-shadow: var(--sg-shadow-pill);
  padding: 6px 12px;
  line-height: 1.1;
  box-sizing: border-box;
}

.sg-capsule-divider {
  width: 1px;
  height: 22px;
  background: linear-gradient(180deg, transparent, rgba(224, 242, 254, 0.3), transparent);
  flex-shrink: 0;
}

/* Score + Combo + Pack Capsule */
.sg-score-pack-capsule {
  padding: 6px 13px;
}

.sg-score-block {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.sg-score-main {
  display: flex;
  align-items: baseline;
  gap: 6px;
}

.sg-score-value {
  font-family: var(--sg-font-display);
  font-size: 24px;
  font-weight: 800;
  letter-spacing: 0.01em;
  font-variant-numeric: tabular-nums;
  color: var(--sg-text-snow);
  text-shadow: 0 1px 2px rgba(2, 6, 23, 0.45);
}

.sg-combo-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 1px 7px;
  border-radius: 999px;
  background: linear-gradient(135deg, rgba(251, 191, 36, 0.95), rgba(245, 158, 11, 0.95));
  border: 1px solid rgba(254, 243, 199, 0.65);
  box-shadow: 0 0 12px rgba(251, 191, 36, 0.38);
  font-family: var(--sg-font-display);
  font-style: italic;
  font-size: 14px;
  font-weight: 800;
  color: #081222;
  letter-spacing: 0.02em;
  transition: transform 0.14s ease, opacity 0.16s ease, background 0.16s ease;
}

.sg-combo-badge.sg-combo-idle {
  opacity: 0.45;
  background: rgba(148, 163, 184, 0.22);
  border-color: rgba(224, 242, 254, 0.16);
  box-shadow: none;
  color: var(--sg-text-mist);
}

.sg-bar-track {
  width: 100%;
  min-width: 72px;
  height: 2.5px;
  background: rgba(224, 242, 254, 0.16);
  border-radius: 999px;
  overflow: hidden;
}

.sg-bar-fill {
  height: 100%;
  width: 0%;
  background: linear-gradient(90deg, var(--sg-accent-ice), var(--sg-accent-aurora), var(--sg-accent-gold));
  border-radius: 999px;
  transition: width 0.06s linear;
}

/* Gift Pack Section */
.sg-bag-card {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 2px 4px;
  border-radius: 999px;
  transition: box-shadow 0.18s ease, background-color 0.18s ease;
}

.sg-bag-card.sg-bag-full {
  background: rgba(251, 191, 36, 0.16);
  box-shadow: 0 0 0 1px rgba(251, 191, 36, 0.72), 0 0 16px rgba(251, 191, 36, 0.28);
  padding: 2px 8px 2px 5px;
}

.sg-bag-icon-wrap {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 19px;
  height: 19px;
  flex-shrink: 0;
}

.sg-bag-icon {
  width: 19px;
  height: 19px;
  display: block;
}

.sg-bag-numbers {
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.sg-bag-count-row {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.sg-bag-count {
  font-family: var(--sg-font-display);
  font-size: 17px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  color: var(--sg-text-snow);
}

.sg-bag-full-tag {
  padding: 1px 5px;
  border-radius: 999px;
  background: var(--sg-accent-gold);
  color: #081222;
  font-size: 9px;
  font-weight: 800;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.sg-delivered-sub {
  font-size: 10px;
  font-weight: 600;
  color: var(--sg-text-mist);
  font-variant-numeric: tabular-nums;
}

/* Coalesced Pickup / Stumble Micro-Chip */
.sg-pickup-chip {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 26px;
  padding: 0 11px 0 14px;
  border-radius: 999px;
  background: linear-gradient(180deg, rgba(240, 248, 255, 0.14) 0%, rgba(12, 24, 44, 0) 65%),
    var(--sg-frost);
  backdrop-filter: blur(10px) saturate(140%);
  -webkit-backdrop-filter: blur(10px) saturate(140%);
  border: 1px solid var(--sg-border-ice);
  box-shadow: var(--sg-shadow-pill);
  overflow: hidden;
  opacity: 0;
  transform: translateX(-10px) scale(0.94);
  transition: opacity 0.16s ease, transform 0.2s cubic-bezier(0.22, 1, 0.36, 1);
}

.sg-pickup-chip.sg-chip-visible {
  opacity: 1;
  transform: translateX(0) scale(1);
}

.sg-pickup-chip[data-tone='gold'] {
  border-color: rgba(251, 191, 36, 0.52);
  box-shadow: 0 6px 20px rgba(251, 191, 36, 0.2), inset 0 1px 0 rgba(254, 243, 199, 0.35);
}

.sg-pickup-chip[data-tone='stumble'] {
  border-color: rgba(249, 115, 22, 0.55);
}

.sg-slant-bar {
  position: absolute;
  left: -3px;
  top: -2px;
  bottom: -2px;
  width: 8px;
  transform: skewX(-14deg);
  background: var(--sg-accent-gift);
}

.sg-pickup-chip[data-tone='gold'] .sg-slant-bar {
  background: linear-gradient(180deg, #fde68a, var(--sg-accent-gold));
}

.sg-pickup-chip[data-tone='stumble'] .sg-slant-bar {
  background: linear-gradient(180deg, #fb923c, var(--sg-accent-amber));
}

.sg-pickup-points {
  font-family: var(--sg-font-display);
  font-size: 15px;
  font-weight: 800;
  letter-spacing: 0.02em;
  font-variant-numeric: tabular-nums;
  color: var(--sg-text-snow);
}

.sg-pickup-chip[data-tone='stumble'] .sg-pickup-points {
  font-family: var(--sg-font-ui);
  font-size: 11px;
  font-weight: 800;
  letter-spacing: 0.04em;
  color: #fed7aa;
}

.sg-pickup-star {
  display: inline-flex;
  width: 13px;
  height: 13px;
  color: var(--sg-accent-gold);
  flex-shrink: 0;
}

.sg-pickup-star svg {
  width: 13px;
  height: 13px;
  display: block;
}

.sg-pickup-count {
  font-family: var(--sg-font-display);
  font-style: italic;
  font-size: 14px;
  font-weight: 800;
  color: var(--sg-accent-gold);
}

/* Top-Right Trail & Pause Capsule */
.sg-trail-capsule {
  padding: 5px 6px 5px 10px;
  gap: 8px;
}

.sg-stage-pill {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  border-radius: 999px;
  transition: box-shadow 0.22s ease, background-color 0.22s ease;
}

.sg-stage-pill.sg-stage-announce {
  background: rgba(56, 189, 248, 0.16);
  box-shadow: 0 0 0 1px rgba(56, 189, 248, 0.55), 0 0 16px rgba(56, 189, 248, 0.28);
  padding: 2px 7px 2px 3px;
}

.sg-stage-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  flex-shrink: 0;
}

.sg-stage-glyph {
  display: block;
  width: 14px;
  height: 14px;
  border-radius: 4px;
  background-color: #2563eb;
  border: 1.5px solid rgba(255, 255, 255, 0.85);
  box-shadow: 0 1px 4px rgba(2, 6, 23, 0.45);
}

.sg-stage-badge[data-shape='diamond'] .sg-stage-glyph {
  width: 12px;
  height: 12px;
  border-radius: 2.5px;
  transform: rotate(45deg);
  border-color: var(--sg-accent-ice);
}

.sg-stage-badge[data-shape='circle'] .sg-stage-glyph {
  border-radius: 999px;
}

.sg-stage-meta {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  max-width: 220px;
  overflow: hidden;
  white-space: nowrap;
  transition: max-width 0.28s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.22s ease;
}

.sg-stage-name {
  font-size: 12px;
  font-weight: 700;
  color: var(--sg-text-snow);
}

.sg-stage-mult {
  padding: 1px 5px;
  border-radius: 999px;
  background: rgba(56, 189, 248, 0.22);
  border: 1px solid rgba(56, 189, 248, 0.45);
  font-family: var(--sg-font-display);
  font-style: italic;
  font-size: 12px;
  font-weight: 800;
  color: #bae6fd;
}

.sg-dist-pill {
  font-family: var(--sg-font-display);
  font-size: 18px;
  font-weight: 700;
  letter-spacing: 0.02em;
  font-variant-numeric: tabular-nums;
  color: var(--sg-text-snow);
  white-space: nowrap;
}

.sg-icon-btn {
  pointer-events: auto;
  cursor: pointer;
  appearance: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  padding: 0;
  border-radius: 999px;
  border: 1px solid rgba(224, 242, 254, 0.24);
  background: rgba(240, 248, 255, 0.14);
  color: var(--sg-text-snow);
  transition: background-color 0.14s ease, transform 0.1s ease, border-color 0.14s ease;
  flex-shrink: 0;
}

.sg-icon-btn:hover {
  background: rgba(240, 248, 255, 0.26);
  border-color: var(--sg-border-ice-strong);
}

.sg-icon-btn:active {
  transform: scale(0.93);
}

.sg-icon-btn svg {
  width: 14px;
  height: 14px;
  display: block;
}

.sg-icon-play {
  display: none;
}

.sg-btn-pause[data-paused='true'] .sg-icon-pause {
  display: none;
}

.sg-btn-pause[data-paused='true'] .sg-icon-play {
  display: inline-flex;
}

/* Desktop Utility Toggle Row */
.sg-toggles {
  display: flex;
  align-items: center;
  gap: 5px;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.sg-toggle-btn {
  pointer-events: auto;
  cursor: pointer;
  appearance: none;
  border: 1px solid var(--sg-border-ice);
  border-radius: 999px;
  background: var(--sg-frost);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  box-shadow: 0 3px 10px rgba(5, 14, 30, 0.22), inset 0 1px 0 rgba(255, 255, 255, 0.16);
  padding: 4px 10px;
  font-family: var(--sg-font-ui);
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.02em;
  color: var(--sg-text-mist);
  transition: transform 0.08s ease, background-color 0.14s ease, color 0.14s ease, border-color 0.14s ease;
}

.sg-toggle-btn:hover {
  background: var(--sg-frost-elevated);
  color: var(--sg-text-snow);
  border-color: var(--sg-border-ice-strong);
}

.sg-toggle-btn:active {
  transform: scale(0.95);
}

.sg-toggle-btn[data-active='true'] {
  color: var(--sg-text-snow);
  border-color: rgba(56, 189, 248, 0.65);
  background: rgba(14, 116, 144, 0.68);
}

.sg-toggle-btn.sg-btn-snow[data-active='true'] {
  border-color: rgba(125, 211, 252, 0.72);
  background: rgba(2, 132, 199, 0.62);
}

.sg-toggle-btn.sg-btn-debug[data-active='true'] {
  border-color: rgba(251, 191, 36, 0.72);
  background: rgba(180, 83, 9, 0.66);
}

.sg-toggle-btn.sg-btn-stats[data-active='true'] {
  border-color: rgba(52, 211, 153, 0.72);
  background: rgba(5, 150, 105, 0.64);
}

/* Single-Slot Top Broadcast Rail (Strictly Above Downhill Horizon) */
.sg-top-rail {
  position: absolute;
  top: max(68px, calc(env(safe-area-inset-top) + 56px));
  left: 50%;
  transform: translateX(-50%);
  width: min(392px, calc(100% - 28px));
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  pointer-events: none;
  z-index: 3;
}

/* Single-Slot Broadcast Ribbon */
.sg-broadcast-ribbon {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  max-width: 100%;
  height: 32px;
  padding: 0 15px 0 18px;
  border-radius: 999px;
  background: linear-gradient(180deg, rgba(240, 248, 255, 0.15) 0%, rgba(12, 24, 44, 0) 68%),
    var(--sg-frost);
  backdrop-filter: blur(12px) saturate(145%);
  -webkit-backdrop-filter: blur(12px) saturate(145%);
  border: 1px solid var(--sg-border-ice);
  box-shadow: var(--sg-shadow-pill);
  overflow: hidden;
  opacity: 0;
  transform: translateY(-6px) scale(0.96);
  transition: opacity 0.18s ease, transform 0.22s cubic-bezier(0.22, 1, 0.36, 1);
  box-sizing: border-box;
}

.sg-broadcast-ribbon.sg-ribbon-visible {
  opacity: 1;
  transform: translateY(0) scale(1);
}

.sg-broadcast-ribbon[data-tone='delivery'] {
  border-color: rgba(52, 211, 153, 0.45);
  box-shadow: 0 8px 24px rgba(5, 150, 105, 0.24), inset 0 1px 0 rgba(255, 255, 255, 0.28);
}

.sg-broadcast-ribbon[data-tone='delivery'] .sg-slant-bar {
  background: linear-gradient(180deg, var(--sg-accent-aurora), var(--sg-accent-gold));
  box-shadow: 0 0 10px rgba(52, 211, 153, 0.6);
}

.sg-broadcast-ribbon[data-tone='warning'] {
  border-color: rgba(251, 113, 133, 0.55);
  box-shadow: 0 8px 24px rgba(249, 115, 22, 0.28), inset 0 1px 0 rgba(255, 255, 255, 0.24);
}

.sg-broadcast-ribbon[data-tone='warning'] .sg-slant-bar {
  background: linear-gradient(180deg, var(--sg-accent-amber), var(--sg-accent-alert));
}

.sg-ribbon-sheen {
  position: absolute;
  inset: 0;
  background: linear-gradient(105deg, transparent 20%, rgba(255, 255, 255, 0.16) 45%, transparent 70%);
  transform: translateX(-100%);
  pointer-events: none;
}

.sg-broadcast-ribbon[data-tone='delivery'].sg-ribbon-visible .sg-ribbon-sheen {
  animation: sg-sheen-sweep 0.9s ease-out 1;
}

@keyframes sg-sheen-sweep {
  0% {
    transform: translateX(-100%);
  }
  100% {
    transform: translateX(120%);
  }
}

.sg-ribbon-content {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  white-space: nowrap;
}

.sg-ribbon-primary {
  font-family: var(--sg-font-display);
  font-size: 18px;
  font-weight: 800;
  letter-spacing: 0.02em;
  font-variant-numeric: tabular-nums;
  color: #6ee7b7;
}

.sg-broadcast-ribbon[data-tone='warning'] .sg-ribbon-primary {
  font-family: var(--sg-font-ui);
  font-size: 12px;
  font-weight: 800;
  letter-spacing: 0.04em;
  color: #fecdd3;
}

.sg-ribbon-sep {
  color: rgba(224, 242, 254, 0.45);
  font-size: 12px;
}

.sg-ribbon-detail {
  font-size: 11.5px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--sg-text-snow);
}

.sg-ribbon-combo {
  padding: 1px 6px;
  border-radius: 999px;
  background: rgba(251, 191, 36, 0.24);
  border: 1px solid rgba(251, 191, 36, 0.65);
  font-family: var(--sg-font-display);
  font-style: italic;
  font-size: 13px;
  font-weight: 800;
  color: #fde68a;
}

/* Zero-Reflow Alternating Bump Animation */
.sg-bump-a {
  animation: sg-bump-kf-a 0.18s cubic-bezier(0.22, 1, 0.36, 1);
}

.sg-bump-b {
  animation: sg-bump-kf-b 0.18s cubic-bezier(0.22, 1, 0.36, 1);
}

@keyframes sg-bump-kf-a {
  0% {
    transform: scale(1);
  }
  45% {
    transform: scale(1.1);
  }
  100% {
    transform: scale(1);
  }
}

@keyframes sg-bump-kf-b {
  0% {
    transform: scale(1);
  }
  45% {
    transform: scale(1.1);
  }
  100% {
    transform: scale(1);
  }
}

/* Peripheral Directional Creature Edge Beacons */
.sg-edge-pulse {
  position: absolute;
  top: 40%;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 34px;
  border-radius: 999px;
  background: linear-gradient(180deg, rgba(240, 248, 255, 0.14) 0%, rgba(12, 24, 44, 0) 65%),
    var(--sg-frost-strong);
  backdrop-filter: blur(10px) saturate(140%);
  -webkit-backdrop-filter: blur(10px) saturate(140%);
  border: 1px solid rgba(251, 113, 133, 0.45);
  box-shadow: 0 0 22px rgba(249, 115, 22, 0.36), var(--sg-shadow-pill);
  overflow: hidden;
  opacity: 0;
  pointer-events: none;
  z-index: 3;
  transition: opacity 0.16s ease, transform 0.2s cubic-bezier(0.22, 1, 0.36, 1);
}

.sg-edge-left {
  left: max(10px, env(safe-area-inset-left));
  padding: 0 11px 0 14px;
  transform: translateY(-50%) translateX(-14px);
}

.sg-edge-right {
  right: max(10px, env(safe-area-inset-right));
  padding: 0 14px 0 11px;
  transform: translateY(-50%) translateX(14px);
}

.sg-edge-pulse.sg-edge-active {
  opacity: 1;
  transform: translateY(-50%) translateX(0);
}

.sg-slant-alert {
  background: linear-gradient(180deg, var(--sg-accent-amber), var(--sg-accent-alert));
}

.sg-slant-right {
  left: auto;
  right: -3px;
}

.sg-edge-chevron {
  display: inline-flex;
  width: 10px;
  height: 12px;
  color: var(--sg-text-snow);
  flex-shrink: 0;
}

.sg-edge-chevron svg {
  width: 10px;
  height: 12px;
  display: block;
}

.sg-edge-creature {
  display: inline-flex;
  width: 24px;
  height: 16px;
  color: var(--sg-text-snow);
  flex-shrink: 0;
}

.sg-edge-creature svg {
  width: 24px;
  height: 16px;
  display: block;
}

.sg-edge-dist {
  font-family: var(--sg-font-display);
  font-size: 16px;
  font-weight: 800;
  font-variant-numeric: tabular-nums;
  color: var(--sg-text-snow);
}

/* Wipeout Banner (Visible only while tumbling) */
.sg-wipeout-banner {
  position: absolute;
  top: 26%;
  left: 50%;
  transform: translateX(-50%);
  width: min(308px, calc(100% - 36px));
  background: linear-gradient(180deg, rgba(251, 113, 133, 0.16) 0%, rgba(30, 12, 24, 0) 65%),
    rgba(28, 12, 26, 0.8);
  backdrop-filter: blur(12px) saturate(140%);
  -webkit-backdrop-filter: blur(12px) saturate(140%);
  border: 1px solid rgba(251, 113, 133, 0.45);
  border-radius: 18px;
  box-shadow: 0 14px 36px rgba(15, 6, 16, 0.5), inset 0 1px 0 rgba(255, 255, 255, 0.2);
  padding: 12px 16px 12px 20px;
  text-align: center;
  overflow: hidden;
  box-sizing: border-box;
  z-index: 4;
}

.sg-wipeout-banner .sg-slant-bar {
  width: 9px;
  background: linear-gradient(180deg, #fda4af, #e11d48);
}

.sg-wipeout-title {
  font-family: var(--sg-font-display);
  font-style: italic;
  font-size: 26px;
  font-weight: 800;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--sg-text-snow);
}

.sg-wipeout-sub {
  font-size: 12px;
  font-weight: 600;
  color: #fecdd3;
  margin: 2px 0 9px;
}

.sg-wipeout-bar {
  height: 4px;
  background: rgba(255, 255, 255, 0.16);
  border-radius: 999px;
  overflow: hidden;
}

.sg-wipeout-fill {
  height: 100%;
  width: 0%;
  background: linear-gradient(90deg, var(--sg-accent-gold), var(--sg-accent-alert));
  border-radius: 999px;
}

/* Bottom Lazy Onboarding Hint */
.sg-hint-pill {
  position: absolute;
  bottom: max(18px, calc(env(safe-area-inset-bottom) + 12px));
  left: 50%;
  transform: translateX(-50%);
  max-width: calc(100% - 28px);
  background: var(--sg-frost-strong);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  color: var(--sg-text-snow);
  border: 1px solid rgba(56, 189, 248, 0.42);
  border-radius: 999px;
  padding: 8px 16px;
  font-size: 11.5px;
  font-weight: 600;
  text-align: center;
  box-shadow: var(--sg-shadow-pill);
  z-index: 3;
}

/* Telemetry Panel */
.sg-telemetry {
  position: absolute;
  top: max(92px, calc(env(safe-area-inset-top) + 84px));
  right: max(12px, env(safe-area-inset-right));
  width: min(296px, calc(100% - 24px));
  background: var(--sg-frost-strong);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  color: var(--sg-text-snow);
  border: 1px solid rgba(56, 189, 248, 0.34);
  border-radius: 16px;
  padding: 10px 13px;
  font-family: var(--sg-font-mono);
  font-size: 11px;
  line-height: 1.48;
  box-shadow: var(--sg-shadow-modal);
  font-variant-numeric: tabular-nums;
  box-sizing: border-box;
  z-index: 4;
}

.sg-tele-title {
  font-family: var(--sg-font-ui);
  font-weight: 800;
  font-size: 10.5px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--sg-accent-ice);
  margin-bottom: 6px;
  border-bottom: 1px solid rgba(224, 242, 254, 0.14);
  padding-bottom: 4px;
}

.sg-tele-row {
  display: flex;
  justify-content: space-between;
  gap: 8px;
}

.sg-tele-key {
  color: var(--sg-text-muted);
}

.sg-tele-val {
  color: var(--sg-text-snow);
  font-weight: 700;
  text-align: right;
}

.sg-tele-val.sg-leak-ok {
  color: var(--sg-accent-aurora);
}

.sg-tele-val.sg-leak-bad {
  color: var(--sg-accent-alert);
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
  background: rgba(6, 14, 30, 0.54);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  pointer-events: auto;
  box-sizing: border-box;
  z-index: 10;
}

.sg-modal {
  position: relative;
  width: min(468px, 100%);
  max-height: 92vh;
  overflow-y: auto;
  background: linear-gradient(165deg, rgba(240, 248, 255, 0.1) 0%, rgba(12, 23, 42, 0) 38%),
    var(--sg-frost-strong);
  backdrop-filter: blur(18px) saturate(145%);
  -webkit-backdrop-filter: blur(18px) saturate(145%);
  border: 1px solid var(--sg-border-ice);
  border-radius: 24px;
  box-shadow: var(--sg-shadow-modal);
  padding: 20px 22px;
  box-sizing: border-box;
  color: var(--sg-text-snow);
}

.sg-modal-kicker {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 10px;
  border-radius: 999px;
  border: 1px solid rgba(56, 189, 248, 0.42);
  background: rgba(56, 189, 248, 0.16);
  color: #bae6fd;
  font-size: 10.5px;
  font-weight: 800;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  margin-bottom: 8px;
}

.sg-modal-title {
  margin: 0;
  font-family: var(--sg-font-display);
  font-size: 34px;
  font-weight: 800;
  line-height: 1.02;
  letter-spacing: 0.02em;
  text-transform: uppercase;
  color: var(--sg-text-snow);
}

.sg-modal-sub {
  margin: 6px 0 14px;
  font-size: 13px;
  font-weight: 500;
  line-height: 1.45;
  color: var(--sg-text-mist);
}

.sg-summary-strip {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
  margin-bottom: 14px;
}

.sg-summary-stat {
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(224, 242, 254, 0.16);
  border-radius: 14px;
  padding: 8px 6px;
  text-align: center;
}

.sg-summary-stat-label {
  font-size: 9.5px;
  font-weight: 700;
  letter-spacing: 0.06em;
  color: var(--sg-text-muted);
  text-transform: uppercase;
  margin-bottom: 2px;
}

.sg-summary-stat-val {
  font-family: var(--sg-font-display);
  font-size: 19px;
  font-weight: 800;
  font-variant-numeric: tabular-nums;
  color: var(--sg-text-snow);
}

.sg-section-label {
  font-size: 10.5px;
  font-weight: 800;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--sg-text-muted);
  margin-bottom: 7px;
}

.sg-skier-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 9px;
  margin-bottom: 14px;
}

.sg-skier-card {
  position: relative;
  cursor: pointer;
  appearance: none;
  text-align: left;
  font-family: var(--sg-font-ui);
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(224, 242, 254, 0.18);
  border-radius: 16px;
  padding: 11px 12px 11px 14px;
  overflow: hidden;
  color: var(--sg-text-snow);
  transition: transform 0.1s ease, background-color 0.16s ease, border-color 0.16s ease, box-shadow 0.16s ease;
}

.sg-skier-card:hover {
  background: rgba(255, 255, 255, 0.11);
  border-color: var(--sg-border-ice-strong);
}

.sg-skier-card:active {
  transform: scale(0.98);
}

.sg-skier-card[data-selected='true'] {
  background: rgba(56, 189, 248, 0.16);
  border-color: rgba(56, 189, 248, 0.78);
  box-shadow: 0 0 0 1px rgba(56, 189, 248, 0.35), 0 10px 24px rgba(14, 165, 233, 0.22);
}

.sg-skier-card[data-selected='true']::before {
  content: '';
  position: absolute;
  left: -3px;
  top: -2px;
  bottom: -2px;
  width: 7px;
  transform: skewX(-12deg);
  background: linear-gradient(180deg, var(--sg-accent-ice), var(--sg-accent-aurora));
}

.sg-skier-top {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}

.sg-skier-swatch {
  width: 15px;
  height: 15px;
  border-radius: 999px;
  border: 1.5px solid rgba(255, 255, 255, 0.8);
  flex-shrink: 0;
}

.sg-skier-name {
  font-size: 13px;
  font-weight: 800;
  line-height: 1.2;
  color: var(--sg-text-snow);
}

.sg-skier-meta {
  font-size: 11px;
  font-weight: 600;
  color: var(--sg-text-mist);
}

.sg-skier-perk {
  margin-top: 6px;
  display: inline-block;
  padding: 2px 8px;
  border-radius: 999px;
  background: rgba(251, 191, 36, 0.16);
  border: 1px solid rgba(251, 191, 36, 0.42);
  color: #fde68a;
  font-size: 10px;
  font-weight: 700;
}

/* Pause Quick Toggles Row inside Modal */
.sg-modal-toggles {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
  margin-bottom: 14px;
}

.sg-modal-toggle-btn {
  flex: 1;
  min-width: 92px;
  cursor: pointer;
  appearance: none;
  font-family: var(--sg-font-ui);
  font-size: 11px;
  font-weight: 700;
  padding: 7px 10px;
  border-radius: 12px;
  border: 1px solid rgba(224, 242, 254, 0.2);
  background: rgba(255, 255, 255, 0.06);
  color: var(--sg-text-mist);
  transition: background-color 0.14s ease, border-color 0.14s ease, color 0.14s ease;
}

.sg-modal-toggle-btn:hover {
  background: rgba(255, 255, 255, 0.12);
  color: var(--sg-text-snow);
}

.sg-modal-toggle-btn[data-active='true'] {
  color: var(--sg-text-snow);
  border-color: rgba(56, 189, 248, 0.68);
  background: rgba(2, 132, 199, 0.44);
}

.sg-modal-toggle-btn.sg-modal-btn-debug[data-active='true'] {
  border-color: rgba(251, 191, 36, 0.68);
  background: rgba(180, 83, 9, 0.46);
}

.sg-modal-toggle-btn.sg-modal-btn-stats[data-active='true'] {
  border-color: rgba(52, 211, 153, 0.68);
  background: rgba(5, 150, 105, 0.44);
}

.sg-controls-box {
  background: rgba(6, 14, 28, 0.48);
  border: 1px solid rgba(224, 242, 254, 0.14);
  border-radius: 14px;
  padding: 10px 12px;
  margin-bottom: 16px;
  font-size: 11.5px;
  line-height: 1.55;
  color: var(--sg-text-mist);
}

.sg-controls-line {
  margin-bottom: 3px;
}

.sg-controls-line:last-child {
  margin-bottom: 0;
}

.sg-controls-line strong {
  color: var(--sg-text-snow);
  font-weight: 700;
}

.sg-kbd {
  display: inline-block;
  padding: 0 5px;
  border-radius: 5px;
  background: rgba(240, 248, 255, 0.12);
  border: 1px solid rgba(224, 242, 254, 0.24);
  font-family: var(--sg-font-mono);
  font-size: 10px;
  color: var(--sg-text-snow);
}

.sg-modal-actions {
  display: flex;
  gap: 10px;
}

.sg-cta-btn {
  flex: 1;
  cursor: pointer;
  appearance: none;
  font-family: var(--sg-font-display);
  font-size: 19px;
  font-weight: 800;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  padding: 11px 16px;
  border-radius: 14px;
  border: 1px solid transparent;
  transition: transform 0.1s ease, filter 0.14s ease, box-shadow 0.14s ease;
}

.sg-cta-btn:hover {
  filter: brightness(1.06);
}

.sg-cta-btn:active {
  transform: scale(0.98);
}

.sg-cta-primary {
  background: linear-gradient(135deg, #38bdf8 0%, #34d399 100%);
  border-color: rgba(224, 242, 254, 0.65);
  box-shadow: 0 10px 26px rgba(52, 211, 153, 0.28), inset 0 1px 0 rgba(255, 255, 255, 0.55);
  color: #061524;
}

.sg-cta-secondary {
  background: rgba(255, 255, 255, 0.1);
  border-color: var(--sg-border-ice);
  color: var(--sg-text-snow);
}

@media (max-width: 640px) {
  .sg-topbar {
    gap: 6px;
  }

  .sg-hud-capsule {
    padding: 4px 9px;
    gap: 7px;
  }

  .sg-score-pack-capsule {
    padding: 4px 10px;
  }

  .sg-score-value {
    font-size: 20px;
  }

  .sg-combo-badge {
    font-size: 12px;
    padding: 1px 5px;
  }

  .sg-bar-track {
    min-width: 58px;
  }

  .sg-bag-count {
    font-size: 15px;
  }

  .sg-delivered-sub {
    display: none;
  }

  .sg-trail-capsule {
    padding: 4px 4px 4px 8px;
    gap: 6px;
  }

  .sg-stage-meta {
    max-width: 0;
    opacity: 0;
  }

  .sg-stage-pill.sg-stage-announce .sg-stage-meta {
    max-width: 170px;
    opacity: 1;
  }

  .sg-dist-pill {
    font-size: 16px;
  }

  .sg-icon-btn {
    width: 26px;
    height: 26px;
  }

  .sg-toggles {
    display: none;
  }

  .sg-top-rail {
    top: max(56px, calc(env(safe-area-inset-top) + 46px));
  }

  .sg-skier-grid {
    grid-template-columns: 1fr;
  }

  .sg-summary-strip {
    grid-template-columns: repeat(2, 1fr);
  }
}
`;
