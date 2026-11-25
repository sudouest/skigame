import { SKIERS } from '../content/characters';
import type { EventBus, Unsubscribe } from '../core/eventBus';
import type { TiltControlStatus } from '../core/input';
import type { SimEventMap } from '../sim/contracts';
import {
  computeRatio01,
  formatControlsHint,
  formatCreatureEdgeBeacon,
  formatDeliveryRibbon,
  formatDistanceM,
  formatLeakCheckSummary,
  formatMultiplier,
  formatPickupBurstChip,
  formatScore,
  formatSkierCardInfo,
  formatStageDisplay,
  formatStumbleChip,
  formatTiltStatusText,
  formatTrianglesCount,
} from './hudFormatting';
import { HUD_STYLES } from './styles';
import type { GameUICallbacks, GameUIUpdateData, OverlayMode } from './types';

const LAZY_HINT_DELAY_SEC = 8.0;
const PICKUP_CHIP_DURATION_SEC = 1.45;
const STAGE_ANNOUNCE_DURATION_SEC = 2.2;
const STUMBLE_FLASH_DURATION_SEC = 0.28;

const GIFT_ICON_SVG =
  '<svg class="sg-bag-icon" viewBox="0 0 24 24" aria-hidden="true">' +
  '<rect x="3" y="9" width="18" height="12" rx="2.5" fill="#ff4d6d"/>' +
  '<rect x="2" y="5.5" width="20" height="4.5" rx="1.8" fill="#fbbf24"/>' +
  '<rect x="10.4" y="5.5" width="3.2" height="15.5" fill="#f8fafc"/>' +
  '<path d="M12 5.5C9.5 5.5 7.5 3.8 8.4 2.3C9.3 0.9 11.4 2.4 12 5.5Z" fill="#fde68a"/>' +
  '<path d="M12 5.5C14.5 5.5 16.5 3.8 15.6 2.3C14.7 0.9 12.6 2.4 12 5.5Z" fill="#fde68a"/>' +
  '</svg>';

const STAR_ICON_SVG =
  '<svg viewBox="0 0 16 16" aria-hidden="true">' +
  '<path fill="currentColor" d="M8 1.2L9.9 5.3L14.4 5.9L11.1 9L11.9 13.5L8 11.3L4.1 13.5L4.9 9L1.6 5.9L6.1 5.3Z"/>' +
  '</svg>';

const BEAR_ICON_SVG =
  '<svg viewBox="0 0 28 18" aria-hidden="true">' +
  '<path fill="currentColor" d="M5.2 6.8C5.2 5.5 6.3 4.5 7.7 4.4C9.5 4.2 11.2 4.9 13.5 4.9C15.9 4.9 18 4.2 20.1 4.6C21.6 4.9 22.8 5.9 23.6 7.1L25.4 7.7C26.1 7.9 26.5 8.6 26.3 9.3L26.1 10.1C25.9 10.7 25.3 11.1 24.6 11L22.5 10.8C22 11.6 21.6 12.6 21.6 13.8V16.2C21.6 16.8 21.1 17.2 20.5 17.2H18.9C18.3 17.2 17.9 16.8 17.9 16.2V13.4C16.1 13.7 13.4 13.7 11.7 13.3V16.2C11.7 16.8 11.2 17.2 10.6 17.2H9C8.4 17.2 8 16.8 8 16.2V12.8C6.6 12.1 5.4 10.7 5.2 9.1L4.4 9.5C3.8 9.8 3.2 9.3 3.4 8.6L4.2 6.5C4 6 4.2 5.3 4.7 5C5.2 4.7 5.8 5 6.1 5.5L5.2 6.8ZM22.1 3.7C22.6 3.7 23 4.1 23 4.6C23 5.1 22.6 5.5 22.1 5.5C21.6 5.5 21.2 5.1 21.2 4.6C21.2 4.1 21.6 3.7 22.1 3.7Z"/>' +
  '</svg>';

const CHEVRON_LEFT_SVG =
  '<svg viewBox="0 0 10 12" aria-hidden="true">' +
  '<path fill="currentColor" d="M7.8 1.4L2.4 6L7.8 10.6Z"/>' +
  '</svg>';

const CHEVRON_RIGHT_SVG =
  '<svg viewBox="0 0 10 12" aria-hidden="true">' +
  '<path fill="currentColor" d="M2.2 1.4L7.6 6L2.2 10.6Z"/>' +
  '</svg>';

const PAUSE_PLAY_ICON_SVG =
  '<span class="sg-icon-pause"><svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3.5" y="2.5" width="3.2" height="11" rx="1" fill="currentColor"/><rect x="9.3" y="2.5" width="3.2" height="11" rx="1" fill="currentColor"/></svg></span>' +
  '<span class="sg-icon-play"><svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M4.2 2.6L13 8L4.2 13.4Z"/></svg></span>';

/**
 * Responsive "Alpine Broadcast × Frosted Crystal" HTML/CSS overlay HUD,
 * Start/Pause/Skier Select modal, perimeter notification channels, and Telemetry HUD.
 * Communicates strictly via `ReadonlySimState`, `EventBus<SimEventMap>`, `ProfilerSnapshot`,
 * and plain UI interfaces (zero `three` imports, zero per-frame DOM node creation).
 */
export class GameUI {
  private readonly mountEl: HTMLElement;
  private readonly callbacks: GameUICallbacks;
  private readonly rootEl: HTMLDivElement;
  private readonly unsubscribers: Unsubscribe[] = [];
  private readonly skierClickHandlers: Array<{ btn: HTMLButtonElement; handler: () => void }> = [];

  // Stumble peripheral flash
  private readonly stumbleFlashEl: HTMLDivElement;
  private stumbleFlashTimerSec = 0;

  // Score & Combo
  private readonly scoreValueEl: HTMLSpanElement;
  private readonly comboBadgeEl: HTMLSpanElement;
  private readonly comboFillEl: HTMLDivElement;

  // Bag & Delivered
  private readonly bagCardEl: HTMLDivElement;
  private readonly bagCountEl: HTMLSpanElement;
  private readonly bagFullTagEl: HTMLSpanElement;
  private readonly deliveredSubEl: HTMLSpanElement;

  // Coalesced Pickup / Stumble Micro-Chip (Top-Left)
  private readonly pickupChipEl: HTMLDivElement;
  private readonly pickupPointsEl: HTMLSpanElement;
  private readonly pickupStarEl: HTMLSpanElement;
  private readonly pickupCountEl: HTMLSpanElement;
  private pickupAccumPoints = 0;
  private pickupAccumCount = 0;
  private pickupHasGolden = false;
  private pickupTimerSec = 0;
  private pickupTone: '' | 'gift' | 'gold' | 'stumble' = '';
  private pickupBumpToggle = false;

  // Stage & Distance & Pause
  private readonly stagePillEl: HTMLDivElement;
  private readonly stageBadgeEl: HTMLSpanElement;
  private readonly stageGlyphEl: HTMLSpanElement;
  private readonly stageNameEl: HTMLSpanElement;
  private readonly stageMultEl: HTMLSpanElement;
  private readonly distancePillEl: HTMLDivElement;
  private readonly pauseBtn: HTMLButtonElement;
  private stageAnnounceTimerSec = 0;

  // Desktop Toggle Buttons
  private readonly tiltBtn: HTMLButtonElement;
  private readonly snowBtn: HTMLButtonElement;
  private readonly debugBtn: HTMLButtonElement;
  private readonly statsBtn: HTMLButtonElement;

  // Top Broadcast Rail (Single-Slot Ribbon)
  private readonly ribbonEl: HTMLDivElement;
  private readonly ribbonPrimaryEl: HTMLSpanElement;
  private readonly ribbonSepEl: HTMLSpanElement;
  private readonly ribbonDetailEl: HTMLSpanElement;
  private readonly ribbonComboEl: HTMLSpanElement;
  private ribbonTimerSec = 0;
  private ribbonBumpToggle = false;

  // Wipeout Banner (only visible during tumble)
  private readonly wipeoutBannerEl: HTMLDivElement;
  private readonly wipeoutSubEl: HTMLDivElement;
  private readonly wipeoutFillEl: HTMLDivElement;

  // Peripheral Creature Edge Beacons
  private readonly edgeLeftEl: HTMLDivElement;
  private readonly edgeLeftDistEl: HTMLSpanElement;
  private readonly edgeRightEl: HTMLDivElement;
  private readonly edgeRightDistEl: HTMLSpanElement;
  private edgeLeftTimerSec = 0;
  private edgeRightTimerSec = 0;

  // Lazy onboarding hint
  private readonly hintPillEl: HTMLDivElement;
  private activePlaySec = 0;

  // Telemetry Panel
  private readonly telemetryEl: HTMLDivElement;
  private readonly teleFpsEl: HTMLSpanElement;
  private readonly teleFrameEl: HTMLSpanElement;
  private readonly teleTimingsEl: HTMLSpanElement;
  private readonly teleDrawsEl: HTMLSpanElement;
  private readonly teleChunksEl: HTMLSpanElement;
  private readonly teleRebasesEl: HTMLSpanElement;
  private readonly teleObjsEl: HTMLSpanElement;
  private readonly teleResEl: HTMLSpanElement;
  private readonly teleGeoTexEl: HTMLSpanElement;
  private readonly teleLeakEl: HTMLSpanElement;

  // Overlay Modal
  private readonly overlayEl: HTMLDivElement;
  private readonly overlayKickerEl: HTMLSpanElement;
  private readonly overlayTitleEl: HTMLHeadingElement;
  private readonly overlaySubEl: HTMLParagraphElement;
  private readonly summaryStripEl: HTMLDivElement;
  private readonly summaryScoreEl: HTMLDivElement;
  private readonly summaryDistEl: HTMLDivElement;
  private readonly summaryDeliveredEl: HTMLDivElement;
  private readonly summaryComboEl: HTMLDivElement;
  private readonly skierButtons = new Map<string, HTMLButtonElement>();
  private readonly dragModeBtn: HTMLButtonElement;
  private readonly tiltModeBtn: HTMLButtonElement;
  private readonly tiltStatusEl: HTMLDivElement;
  private readonly modalTogglesEl: HTMLDivElement;
  private readonly modalSnowBtn: HTMLButtonElement;
  private readonly modalDebugBtn: HTMLButtonElement;
  private readonly modalStatsBtn: HTMLButtonElement;
  private readonly primaryActionBtn: HTMLButtonElement;
  private readonly restartActionBtn: HTMLButtonElement;

  // Dirty-checking cache (avoids unnecessary DOM mutations in 60-144 Hz loop)
  private lastScoreText = '';
  private lastComboText = '';
  private lastComboIdle = true;
  private lastComboWidth = '';
  private lastBagText = '';
  private lastBagFull = false;
  private lastDeliveredText = '';
  private lastStageId = '';
  private lastDistanceText = '';
  private lastSnowActive = false;
  private lastDebugActive = false;
  private lastStatsActive = false;
  private lastTiltEnabled = false;
  private lastTiltStatus: TiltControlStatus | '' = '';
  private lastHintText = '';
  private tiltFeedbackPending = false;
  private lastOverlayMode: OverlayMode | '' = '';
  private lastSelectedSkierId = '';
  private lastWipeoutActive = false;
  private lastWipeoutWidth = '';
  private lastHintVisible = false;
  private lastTelemetryVisible = false;
  private lastTelemetryTextKey = '';
  private lastSummaryKey = '';
  private disposed = false;

  // Bound event listeners
  private readonly onTiltToggleClick = (): void => {
    const currentlyActive =
      this.lastTiltEnabled &&
      (this.lastTiltStatus === 'active' || this.lastTiltStatus === 'waiting');
    const shouldEnable = !currentlyActive;
    if (shouldEnable) {
      this.tiltFeedbackPending = true;
    } else {
      this.tiltFeedbackPending = false;
    }
    this.callbacks.onSetTiltEnabled(shouldEnable);
    this.tiltBtn.blur();
  };
  private readonly onDragModeClick = (): void => {
    this.tiltFeedbackPending = false;
    this.callbacks.onSetTiltEnabled(false);
    this.dragModeBtn.blur();
  };
  private readonly onTiltModeClick = (): void => {
    this.tiltFeedbackPending = false;
    this.callbacks.onSetTiltEnabled(true);
    this.tiltModeBtn.blur();
  };
  private readonly onSnowClick = (): void => {
    this.snowBtn.blur();
    this.modalSnowBtn.blur();
    this.callbacks.onToggleBlizzard();
  };
  private readonly onDebugClick = (): void => {
    this.debugBtn.blur();
    this.modalDebugBtn.blur();
    this.callbacks.onToggleDebugDraw();
  };
  private readonly onStatsClick = (): void => {
    this.statsBtn.blur();
    this.modalStatsBtn.blur();
    this.callbacks.onToggleTelemetry();
  };
  private readonly onPauseClick = (): void => {
    this.pauseBtn.blur();
    this.callbacks.onTogglePause();
  };
  private readonly onPrimaryActionClick = (): void => {
    this.primaryActionBtn.blur();
    if (this.lastOverlayMode === 'paused') {
      this.callbacks.onResume();
    } else if (this.lastOverlayMode === 'gameover') {
      this.callbacks.onRestart();
    } else {
      this.callbacks.onStart();
    }
  };
  private readonly onRestartActionClick = (): void => {
    this.restartActionBtn.blur();
    this.callbacks.onRestart();
  };

  constructor(
    mountEl: HTMLElement,
    eventBus: EventBus<SimEventMap>,
    callbacks: GameUICallbacks,
  ) {
    this.mountEl = mountEl;
    this.callbacks = callbacks;

    const doc = mountEl.ownerDocument;
    this.rootEl = doc.createElement('div');
    this.rootEl.className = 'sg-root';

    const styleEl = doc.createElement('style');
    styleEl.textContent = HUD_STYLES;
    this.rootEl.appendChild(styleEl);

    // 0. Stumble Peripheral Vignette Flash
    this.stumbleFlashEl = doc.createElement('div');
    this.stumbleFlashEl.className = 'sg-stumble-flash';

    // 1. Top Bar
    const topBar = doc.createElement('div');
    topBar.className = 'sg-topbar';

    const topLeft = doc.createElement('div');
    topLeft.className = 'sg-cluster-left';

    const scorePackCapsule = doc.createElement('div');
    scorePackCapsule.className = 'sg-hud-capsule sg-score-pack-capsule';

    const scoreBlock = doc.createElement('div');
    scoreBlock.className = 'sg-score-block';
    const scoreMain = doc.createElement('div');
    scoreMain.className = 'sg-score-main';
    this.scoreValueEl = doc.createElement('span');
    this.scoreValueEl.className = 'sg-score-value';
    this.scoreValueEl.textContent = '0';
    this.comboBadgeEl = doc.createElement('span');
    this.comboBadgeEl.className = 'sg-combo-badge sg-combo-idle';
    this.comboBadgeEl.textContent = '×1';
    scoreMain.append(this.scoreValueEl, this.comboBadgeEl);

    const comboTrack = doc.createElement('div');
    comboTrack.className = 'sg-bar-track';
    this.comboFillEl = doc.createElement('div');
    this.comboFillEl.className = 'sg-bar-fill';
    comboTrack.appendChild(this.comboFillEl);
    scoreBlock.append(scoreMain, comboTrack);

    const leftDivider = doc.createElement('div');
    leftDivider.className = 'sg-capsule-divider';

    this.bagCardEl = doc.createElement('div');
    this.bagCardEl.className = 'sg-bag-card';
    const bagIconWrap = doc.createElement('span');
    bagIconWrap.className = 'sg-bag-icon-wrap';
    bagIconWrap.innerHTML = GIFT_ICON_SVG;

    const bagNumbers = doc.createElement('div');
    bagNumbers.className = 'sg-bag-numbers';
    const bagCountRow = doc.createElement('div');
    bagCountRow.className = 'sg-bag-count-row';
    this.bagCountEl = doc.createElement('span');
    this.bagCountEl.className = 'sg-bag-count';
    this.bagCountEl.textContent = '0/12';
    this.bagFullTagEl = doc.createElement('span');
    this.bagFullTagEl.className = 'sg-bag-full-tag sg-hidden';
    this.bagFullTagEl.textContent = 'FULL';
    bagCountRow.append(this.bagCountEl, this.bagFullTagEl);

    this.deliveredSubEl = doc.createElement('span');
    this.deliveredSubEl.className = 'sg-delivered-sub';
    this.deliveredSubEl.textContent = '0 Delivered';
    bagNumbers.append(bagCountRow, this.deliveredSubEl);
    this.bagCardEl.append(bagIconWrap, bagNumbers);

    scorePackCapsule.append(scoreBlock, leftDivider, this.bagCardEl);

    // Coalesced Pickup / Stumble Micro-Chip tucked beneath top-left capsule
    this.pickupChipEl = doc.createElement('div');
    this.pickupChipEl.className = 'sg-pickup-chip sg-hidden';
    this.pickupChipEl.dataset.tone = 'gift';
    const pickupSlant = doc.createElement('span');
    pickupSlant.className = 'sg-slant-bar';
    this.pickupPointsEl = doc.createElement('span');
    this.pickupPointsEl.className = 'sg-pickup-points';
    this.pickupStarEl = doc.createElement('span');
    this.pickupStarEl.className = 'sg-pickup-star sg-hidden';
    this.pickupStarEl.innerHTML = STAR_ICON_SVG;
    this.pickupCountEl = doc.createElement('span');
    this.pickupCountEl.className = 'sg-pickup-count sg-hidden';
    this.pickupChipEl.append(pickupSlant, this.pickupPointsEl, this.pickupStarEl, this.pickupCountEl);

    topLeft.append(scorePackCapsule, this.pickupChipEl);

    // Top-Right: Trail Pill + Distance + Pause Capsule & Utility Row
    const topRight = doc.createElement('div');
    topRight.className = 'sg-cluster-right';

    const trailCapsule = doc.createElement('div');
    trailCapsule.className = 'sg-hud-capsule sg-trail-capsule';

    this.stagePillEl = doc.createElement('div');
    this.stagePillEl.className = 'sg-stage-pill';
    this.stageBadgeEl = doc.createElement('span');
    this.stageBadgeEl.className = 'sg-stage-badge';
    this.stageBadgeEl.dataset.shape = 'square';
    this.stageGlyphEl = doc.createElement('span');
    this.stageGlyphEl.className = 'sg-stage-glyph';
    this.stageBadgeEl.appendChild(this.stageGlyphEl);

    const stageMeta = doc.createElement('span');
    stageMeta.className = 'sg-stage-meta';
    this.stageNameEl = doc.createElement('span');
    this.stageNameEl.className = 'sg-stage-name';
    this.stageMultEl = doc.createElement('span');
    this.stageMultEl.className = 'sg-stage-mult sg-hidden';
    stageMeta.append(this.stageNameEl, this.stageMultEl);
    this.stagePillEl.append(this.stageBadgeEl, stageMeta);

    const rightDivider = doc.createElement('div');
    rightDivider.className = 'sg-capsule-divider';

    this.distancePillEl = doc.createElement('div');
    this.distancePillEl.className = 'sg-dist-pill';
    this.distancePillEl.textContent = '0 m';

    this.pauseBtn = doc.createElement('button');
    this.pauseBtn.type = 'button';
    this.pauseBtn.className = 'sg-icon-btn sg-btn-pause';
    this.pauseBtn.dataset.paused = 'false';
    this.setAttr(this.pauseBtn, 'aria-label', 'Pause');
    this.setAttr(this.pauseBtn, 'title', 'Pause [Esc]');
    this.pauseBtn.innerHTML = PAUSE_PLAY_ICON_SVG;
    this.pauseBtn.addEventListener('click', this.onPauseClick);

    trailCapsule.append(this.stagePillEl, rightDivider, this.distancePillEl, this.pauseBtn);

    const togglesRow = doc.createElement('div');
    togglesRow.className = 'sg-toggles';
    this.tiltBtn = this.makeToggleButton(doc, 'Tilt', 'sg-toggle-btn sg-btn-tilt', this.onTiltToggleClick);
    this.setAttr(this.tiltBtn, 'title', 'Toggle Tilt Steering');
    this.snowBtn = this.makeToggleButton(doc, 'Snow [B]', 'sg-toggle-btn sg-btn-snow', this.onSnowClick);
    this.debugBtn = this.makeToggleButton(doc, 'Debug [G]', 'sg-toggle-btn sg-btn-debug', this.onDebugClick);
    this.statsBtn = this.makeToggleButton(doc, 'Stats [P]', 'sg-toggle-btn sg-btn-stats', this.onStatsClick);
    togglesRow.append(this.tiltBtn, this.snowBtn, this.debugBtn, this.statsBtn);

    topRight.append(trailCapsule, togglesRow);
    topBar.append(topLeft, topRight);

    // 2. Single-Slot Top Broadcast Rail (Strictly Above Horizon)
    const topRail = doc.createElement('div');
    topRail.className = 'sg-top-rail';

    this.ribbonEl = doc.createElement('div');
    this.ribbonEl.className = 'sg-broadcast-ribbon sg-hidden';
    this.ribbonEl.dataset.tone = 'delivery';
    const ribbonSlant = doc.createElement('span');
    ribbonSlant.className = 'sg-slant-bar';
    const ribbonSheen = doc.createElement('span');
    ribbonSheen.className = 'sg-ribbon-sheen';
    const ribbonContent = doc.createElement('div');
    ribbonContent.className = 'sg-ribbon-content';
    this.ribbonPrimaryEl = doc.createElement('span');
    this.ribbonPrimaryEl.className = 'sg-ribbon-primary';
    this.ribbonSepEl = doc.createElement('span');
    this.ribbonSepEl.className = 'sg-ribbon-sep';
    this.ribbonSepEl.textContent = '·';
    this.ribbonDetailEl = doc.createElement('span');
    this.ribbonDetailEl.className = 'sg-ribbon-detail';
    this.ribbonComboEl = doc.createElement('span');
    this.ribbonComboEl.className = 'sg-ribbon-combo sg-hidden';
    ribbonContent.append(this.ribbonPrimaryEl, this.ribbonSepEl, this.ribbonDetailEl, this.ribbonComboEl);
    this.ribbonEl.append(ribbonSlant, ribbonSheen, ribbonContent);

    topRail.appendChild(this.ribbonEl);

    // 3. Wipeout Recovery Banner (centered only during tumble)
    this.wipeoutBannerEl = doc.createElement('div');
    this.wipeoutBannerEl.className = 'sg-wipeout-banner sg-hidden';
    const wipeoutSlant = doc.createElement('span');
    wipeoutSlant.className = 'sg-slant-bar';
    const wipeoutTitle = doc.createElement('div');
    wipeoutTitle.className = 'sg-wipeout-title';
    wipeoutTitle.textContent = 'Wipeout!';
    this.wipeoutSubEl = doc.createElement('div');
    this.wipeoutSubEl.className = 'sg-wipeout-sub';
    this.wipeoutSubEl.textContent = 'Tumbling... Back on skis soon!';
    const wipeoutBar = doc.createElement('div');
    wipeoutBar.className = 'sg-wipeout-bar';
    this.wipeoutFillEl = doc.createElement('div');
    this.wipeoutFillEl.className = 'sg-wipeout-fill';
    wipeoutBar.appendChild(this.wipeoutFillEl);
    this.wipeoutBannerEl.append(wipeoutSlant, wipeoutTitle, this.wipeoutSubEl, wipeoutBar);

    // 4. Peripheral Directional Creature Edge Beacons
    this.edgeLeftEl = doc.createElement('div');
    this.edgeLeftEl.className = 'sg-edge-pulse sg-edge-left sg-hidden';
    const edgeLeftSlant = doc.createElement('span');
    edgeLeftSlant.className = 'sg-slant-bar sg-slant-alert';
    const edgeLeftChevron = doc.createElement('span');
    edgeLeftChevron.className = 'sg-edge-chevron';
    edgeLeftChevron.innerHTML = CHEVRON_LEFT_SVG;
    const edgeLeftBear = doc.createElement('span');
    edgeLeftBear.className = 'sg-edge-creature';
    edgeLeftBear.innerHTML = BEAR_ICON_SVG;
    this.edgeLeftDistEl = doc.createElement('span');
    this.edgeLeftDistEl.className = 'sg-edge-dist';
    this.edgeLeftDistEl.textContent = '0m';
    this.edgeLeftEl.append(edgeLeftSlant, edgeLeftChevron, edgeLeftBear, this.edgeLeftDistEl);

    this.edgeRightEl = doc.createElement('div');
    this.edgeRightEl.className = 'sg-edge-pulse sg-edge-right sg-hidden';
    const edgeRightSlant = doc.createElement('span');
    edgeRightSlant.className = 'sg-slant-bar sg-slant-alert sg-slant-right';
    this.edgeRightDistEl = doc.createElement('span');
    this.edgeRightDistEl.className = 'sg-edge-dist';
    this.edgeRightDistEl.textContent = '0m';
    const edgeRightBear = doc.createElement('span');
    edgeRightBear.className = 'sg-edge-creature';
    edgeRightBear.innerHTML = BEAR_ICON_SVG;
    const edgeRightChevron = doc.createElement('span');
    edgeRightChevron.className = 'sg-edge-chevron';
    edgeRightChevron.innerHTML = CHEVRON_RIGHT_SVG;
    this.edgeRightEl.append(this.edgeRightDistEl, edgeRightBear, edgeRightChevron, edgeRightSlant);

    // 5. Lazy Onboarding Hint
    this.hintPillEl = doc.createElement('div');
    this.hintPillEl.className = 'sg-hint-pill sg-hidden';
    this.lastHintText = formatControlsHint(false);
    this.hintPillEl.textContent = this.lastHintText;

    // 6. Telemetry Panel
    this.telemetryEl = doc.createElement('div');
    this.telemetryEl.className = 'sg-telemetry sg-hidden';
    const teleTitle = doc.createElement('div');
    teleTitle.className = 'sg-tele-title';
    teleTitle.textContent = 'Telemetry & Leak Monitor';
    this.telemetryEl.appendChild(teleTitle);

    this.teleFpsEl = this.addTelemetryRow(doc, this.telemetryEl, 'FPS');
    this.teleFrameEl = this.addTelemetryRow(doc, this.telemetryEl, 'Frame (cur/avg)');
    this.teleTimingsEl = this.addTelemetryRow(doc, this.telemetryEl, 'Sim / Rnd / Strm');
    this.teleDrawsEl = this.addTelemetryRow(doc, this.telemetryEl, 'Draws / Tris');
    this.teleChunksEl = this.addTelemetryRow(doc, this.telemetryEl, 'Chunks (act/q)');
    this.teleRebasesEl = this.addTelemetryRow(doc, this.telemetryEl, 'Origin Rebases');
    this.teleObjsEl = this.addTelemetryRow(doc, this.telemetryEl, 'GPU Objects');
    this.teleResEl = this.addTelemetryRow(doc, this.telemetryEl, 'GPU Resources');
    this.teleGeoTexEl = this.addTelemetryRow(doc, this.telemetryEl, 'Geos / Textures');
    this.teleLeakEl = this.addTelemetryRow(doc, this.telemetryEl, 'Leak Check');

    // 7. Start / Pause / Skier Select Overlay
    this.overlayEl = doc.createElement('div');
    this.overlayEl.className = 'sg-overlay';

    const modal = doc.createElement('div');
    modal.className = 'sg-modal';

    this.overlayKickerEl = doc.createElement('span');
    this.overlayKickerEl.className = 'sg-modal-kicker';
    this.overlayKickerEl.textContent = 'Alpine Gift Courier';

    this.overlayTitleEl = doc.createElement('h1');
    this.overlayTitleEl.className = 'sg-modal-title';
    this.overlayTitleEl.textContent = 'Endless Mountain';

    this.overlaySubEl = doc.createElement('p');
    this.overlaySubEl.className = 'sg-modal-sub';
    this.overlaySubEl.textContent =
      'Carve past boulders & bears, stack presents, and toss them to waiting children!';

    this.summaryStripEl = doc.createElement('div');
    this.summaryStripEl.className = 'sg-summary-strip sg-hidden';
    this.summaryScoreEl = this.addSummaryBox(doc, this.summaryStripEl, 'Score');
    this.summaryDistEl = this.addSummaryBox(doc, this.summaryStripEl, 'Distance');
    this.summaryDeliveredEl = this.addSummaryBox(doc, this.summaryStripEl, 'Delivered');
    this.summaryComboEl = this.addSummaryBox(doc, this.summaryStripEl, 'Best Combo');

    const skierLabel = doc.createElement('div');
    skierLabel.className = 'sg-section-label';
    skierLabel.textContent = 'Select Skier';

    const skierGrid = doc.createElement('div');
    skierGrid.className = 'sg-skier-grid';
    for (const skier of Object.values(SKIERS)) {
      const info = formatSkierCardInfo(skier);
      const btn = doc.createElement('button');
      btn.type = 'button';
      btn.className = 'sg-skier-card';
      btn.dataset.skierId = info.id;

      const top = doc.createElement('div');
      top.className = 'sg-skier-top';
      const swatch = doc.createElement('span');
      swatch.className = 'sg-skier-swatch';
      swatch.style.background = `linear-gradient(135deg, ${info.primaryColor} 50%, ${info.accentColor} 50%)`;
      const nameEl = doc.createElement('span');
      nameEl.className = 'sg-skier-name';
      nameEl.textContent = info.name;
      top.append(swatch, nameEl);

      const meta = doc.createElement('div');
      meta.className = 'sg-skier-meta';
      meta.textContent = `${info.maxSpeedLabel} · ${info.capacityLabel}`;

      const perk = doc.createElement('span');
      perk.className = 'sg-skier-perk';
      perk.textContent = info.perkLabel;

      btn.append(top, meta, perk);
      const handler = (): void => {
        btn.blur();
        this.callbacks.onSelectSkier(info.id);
      };
      btn.addEventListener('click', handler);
      this.skierClickHandlers.push({ btn, handler });
      this.skierButtons.set(info.id, btn);
      skierGrid.appendChild(btn);
    }

    const steerSection = doc.createElement('div');
    steerSection.className = 'sg-steer-section';
    const steerLabel = doc.createElement('div');
    steerLabel.className = 'sg-section-label';
    steerLabel.textContent = 'Steering';

    const steerRow = doc.createElement('div');
    steerRow.className = 'sg-steer-row';
    const steerSeg = doc.createElement('div');
    steerSeg.className = 'sg-steer-segment';

    this.dragModeBtn = doc.createElement('button');
    this.dragModeBtn.type = 'button';
    this.dragModeBtn.className = 'sg-steer-btn sg-btn-steer-drag';
    this.dragModeBtn.dataset.active = 'true';
    this.setAttr(this.dragModeBtn, 'aria-pressed', 'true');
    this.dragModeBtn.textContent = 'Touch / Drag';
    this.dragModeBtn.addEventListener('click', this.onDragModeClick);

    this.tiltModeBtn = doc.createElement('button');
    this.tiltModeBtn.type = 'button';
    this.tiltModeBtn.className = 'sg-steer-btn sg-btn-steer-tilt';
    this.tiltModeBtn.dataset.active = 'false';
    this.setAttr(this.tiltModeBtn, 'aria-pressed', 'false');
    this.tiltModeBtn.textContent = 'Tilt';
    this.tiltModeBtn.addEventListener('click', this.onTiltModeClick);

    steerSeg.append(this.dragModeBtn, this.tiltModeBtn);
    steerRow.appendChild(steerSeg);

    this.tiltStatusEl = doc.createElement('div');
    this.tiltStatusEl.className = 'sg-steer-status sg-hidden';
    this.tiltStatusEl.dataset.tone = '';
    this.setAttr(this.tiltStatusEl, 'aria-live', 'polite');

    steerSection.append(steerLabel, steerRow, this.tiltStatusEl);

    this.modalTogglesEl = doc.createElement('div');
    this.modalTogglesEl.className = 'sg-modal-toggles sg-hidden';
    this.modalSnowBtn = this.makeToggleButton(
      doc,
      'Blizzard [B]',
      'sg-modal-toggle-btn sg-modal-btn-snow',
      this.onSnowClick,
    );
    this.modalDebugBtn = this.makeToggleButton(
      doc,
      '3D Debug [G]',
      'sg-modal-toggle-btn sg-modal-btn-debug',
      this.onDebugClick,
    );
    this.modalStatsBtn = this.makeToggleButton(
      doc,
      'Telemetry [P]',
      'sg-modal-toggle-btn sg-modal-btn-stats',
      this.onStatsClick,
    );
    this.modalTogglesEl.append(this.modalSnowBtn, this.modalDebugBtn, this.modalStatsBtn);

    const controlsBox = doc.createElement('div');
    controlsBox.className = 'sg-controls-box';
    controlsBox.innerHTML =
      '<div class="sg-controls-line"><strong>Desktop:</strong> <span class="sg-kbd">A</span>/<span class="sg-kbd">D</span> or Arrows carve · <span class="sg-kbd">Space</span>/<span class="sg-kbd">W</span> jump · <span class="sg-kbd">S</span> brake</div>' +
      '<div class="sg-controls-line"><strong>Mobile:</strong> Drag or Tilt to carve · Tap or swipe up jump · 2-finger brake</div>' +
      '<div class="sg-controls-line"><strong>Toggles:</strong> <span class="sg-kbd">B</span> Blizzard · <span class="sg-kbd">G</span> 3D Debug · <span class="sg-kbd">P</span> Stats · <span class="sg-kbd">Esc</span> Pause</div>';

    const actionsRow = doc.createElement('div');
    actionsRow.className = 'sg-modal-actions';
    this.primaryActionBtn = doc.createElement('button');
    this.primaryActionBtn.type = 'button';
    this.primaryActionBtn.className = 'sg-cta-btn sg-cta-primary';
    this.primaryActionBtn.textContent = 'Start Skiing';
    this.primaryActionBtn.addEventListener('click', this.onPrimaryActionClick);

    this.restartActionBtn = doc.createElement('button');
    this.restartActionBtn.type = 'button';
    this.restartActionBtn.className = 'sg-cta-btn sg-cta-secondary sg-hidden';
    this.restartActionBtn.textContent = 'Restart';
    this.restartActionBtn.addEventListener('click', this.onRestartActionClick);

    actionsRow.append(this.primaryActionBtn, this.restartActionBtn);
    modal.append(
      this.overlayKickerEl,
      this.overlayTitleEl,
      this.overlaySubEl,
      this.summaryStripEl,
      skierLabel,
      skierGrid,
      steerSection,
      this.modalTogglesEl,
      controlsBox,
      actionsRow,
    );
    this.overlayEl.appendChild(modal);

    this.rootEl.append(
      this.stumbleFlashEl,
      topBar,
      topRail,
      this.wipeoutBannerEl,
      this.edgeLeftEl,
      this.edgeRightEl,
      this.hintPillEl,
      this.telemetryEl,
      this.overlayEl,
    );
    this.mountEl.appendChild(this.rootEl);

    // Subscribe to simulation EventBus cues (5 channels)
    this.unsubscribers.push(
      eventBus.on('PRESENT_PICKED_UP', (ev) => {
        this.pushPickupBurst(ev);
      }),
      eventBus.on('PRESENT_DELIVERED', (ev) => {
        this.showDeliveryRibbon(ev);
      }),
      eventBus.on('FORK_ENTERED', () => {
        this.stageAnnounceTimerSec = STAGE_ANNOUNCE_DURATION_SEC;
        this.stagePillEl.classList.add('sg-stage-announce');
      }),
      eventBus.on('CREATURE_TELEGRAPH', (ev) => {
        this.showCreatureAlert(ev);
      }),
      eventBus.on('PLAYER_WIPEOUT', (ev) => {
        this.showStumbleChip(ev);
      }),
    );
  }

  resetRunState(): void {
    this.activePlaySec = 0;
    this.stageAnnounceTimerSec = 0;
    this.stagePillEl.classList.remove('sg-stage-announce');

    this.pickupAccumPoints = 0;
    this.pickupAccumCount = 0;
    this.pickupHasGolden = false;
    this.pickupTimerSec = 0;
    this.pickupTone = '';
    this.pickupChipEl.classList.remove('sg-chip-visible', 'sg-bump-a', 'sg-bump-b');
    this.pickupChipEl.classList.add('sg-hidden');

    this.ribbonTimerSec = 0;
    this.ribbonEl.classList.remove('sg-ribbon-visible', 'sg-bump-a', 'sg-bump-b');
    this.ribbonEl.classList.add('sg-hidden');

    this.edgeLeftTimerSec = 0;
    this.edgeRightTimerSec = 0;
    this.edgeLeftEl.classList.remove('sg-edge-active');
    this.edgeLeftEl.classList.add('sg-hidden');
    this.edgeRightEl.classList.remove('sg-edge-active');
    this.edgeRightEl.classList.add('sg-hidden');

    this.stumbleFlashTimerSec = 0;
    this.stumbleFlashEl.classList.remove('sg-stumble-active');
    this.tiltFeedbackPending = false;
  }

  update(data: GameUIUpdateData, frameDtSec: number): void {
    if (this.disposed) return;

    const {
      simState,
      overlayMode,
      hasSteered,
      debugDrawEnabled,
      telemetryVisible,
      tiltEnabled,
      tiltStatus,
    } = data;
    const dt = Number.isFinite(frameDtSec) && frameDtSec > 0 ? frameDtSec : 0;

    // 1. Score & Combo
    const scoreText = formatScore(simState.score);
    if (scoreText !== this.lastScoreText) {
      this.lastScoreText = scoreText;
      this.scoreValueEl.textContent = scoreText;
    }

    const comboActive = simState.comboTimerSec > 0 || simState.comboMultiplier > 1;
    const comboText = formatMultiplier(simState.comboMultiplier).replace(/^x/, '×');
    if (comboText !== this.lastComboText) {
      this.lastComboText = comboText;
      this.comboBadgeEl.textContent = comboText;
    }
    if (!comboActive !== this.lastComboIdle) {
      this.lastComboIdle = !comboActive;
      this.comboBadgeEl.classList.toggle('sg-combo-idle', this.lastComboIdle);
    }

    const comboRatio = computeRatio01(simState.comboTimerSec, simState.comboDurationSec);
    const comboWidth = `${Math.round(comboRatio * 1000) / 10}%`;
    if (comboWidth !== this.lastComboWidth) {
      this.lastComboWidth = comboWidth;
      this.comboFillEl.style.width = comboWidth;
    }

    // 2. Carried Presents & Total Delivered
    const bagText = `${simState.carriedCount}/${simState.maxCarryCapacity}`;
    if (bagText !== this.lastBagText) {
      this.lastBagText = bagText;
      this.bagCountEl.textContent = bagText;
    }
    const bagFull = simState.maxCarryCapacity > 0 && simState.carriedCount >= simState.maxCarryCapacity;
    if (bagFull !== this.lastBagFull) {
      this.lastBagFull = bagFull;
      this.bagCardEl.classList.toggle('sg-bag-full', bagFull);
      this.bagFullTagEl.classList.toggle('sg-hidden', !bagFull);
    }
    const deliveredText = `${simState.deliveredTotal} Delivered`;
    if (deliveredText !== this.lastDeliveredText) {
      this.lastDeliveredText = deliveredText;
      this.deliveredSubEl.textContent = deliveredText;
    }

    // 3. Stage Pill & Distance
    if (simState.activeStageId !== this.lastStageId) {
      this.lastStageId = simState.activeStageId;
      const stage = formatStageDisplay(simState.activeStageId);
      this.stagePillEl.dataset.stage = stage.id;
      this.stageBadgeEl.dataset.shape = stage.badgeShape;
      this.stageGlyphEl.style.backgroundColor = stage.badgeColor;
      this.stageNameEl.textContent = stage.name;
      if (stage.multiplier > 1) {
        this.stageMultEl.textContent = stage.multiplierLabel.replace(/x$/i, '×');
        this.stageMultEl.classList.remove('sg-hidden');
      } else {
        this.stageMultEl.textContent = '';
        this.stageMultEl.classList.add('sg-hidden');
      }
    }

    const distanceText = formatDistanceM(simState.distanceM);
    if (distanceText !== this.lastDistanceText) {
      this.lastDistanceText = distanceText;
      this.distancePillEl.textContent = distanceText;
    }

    // 4. Toggle Pills (Desktop top-right + Pause Modal sync)
    const blizzardOn = simState.activeWeather.blizzardEnabled;
    if (blizzardOn !== this.lastSnowActive) {
      this.lastSnowActive = blizzardOn;
      const val = String(blizzardOn);
      this.snowBtn.dataset.active = val;
      this.modalSnowBtn.dataset.active = val;
      this.setAttr(this.snowBtn, 'aria-pressed', val);
      this.setAttr(this.modalSnowBtn, 'aria-pressed', val);
    }
    if (debugDrawEnabled !== this.lastDebugActive) {
      this.lastDebugActive = debugDrawEnabled;
      const val = String(debugDrawEnabled);
      this.debugBtn.dataset.active = val;
      this.modalDebugBtn.dataset.active = val;
      this.setAttr(this.debugBtn, 'aria-pressed', val);
      this.setAttr(this.modalDebugBtn, 'aria-pressed', val);
    }
    if (telemetryVisible !== this.lastStatsActive) {
      this.lastStatsActive = telemetryVisible;
      const val = String(telemetryVisible);
      this.statsBtn.dataset.active = val;
      this.modalStatsBtn.dataset.active = val;
      this.setAttr(this.statsBtn, 'aria-pressed', val);
      this.setAttr(this.modalStatsBtn, 'aria-pressed', val);
    }
    const overlayChanged = overlayMode !== this.lastOverlayMode;
    if (tiltEnabled !== this.lastTiltEnabled || tiltStatus !== this.lastTiltStatus || overlayChanged) {
      this.lastTiltEnabled = tiltEnabled;
      this.lastTiltStatus = tiltStatus;
      const tiltActiveOrWaiting =
        tiltEnabled && (tiltStatus === 'active' || tiltStatus === 'waiting');
      const tiltSelected =
        tiltActiveOrWaiting || tiltStatus === 'requesting';
      const tiltSupported = tiltStatus !== 'unsupported';
      const tiltUnavailable = !tiltSupported || tiltStatus === 'insecure';

      this.tiltBtn.classList.toggle('sg-hidden', !tiltSupported);
      const tiltBtnActiveStr = String(tiltActiveOrWaiting);
      this.tiltBtn.dataset.active = tiltBtnActiveStr;
      this.setAttr(this.tiltBtn, 'aria-pressed', tiltBtnActiveStr);

      const dragSelectedStr = String(!tiltSelected);
      const tiltSelectedStr = String(tiltSelected);
      this.dragModeBtn.dataset.active = dragSelectedStr;
      this.setAttr(this.dragModeBtn, 'aria-pressed', dragSelectedStr);
      this.tiltModeBtn.dataset.active = tiltSelectedStr;
      this.setAttr(this.tiltModeBtn, 'aria-pressed', tiltSelectedStr);
      this.tiltModeBtn.dataset.disabled = String(tiltUnavailable);
      this.setAttr(this.tiltModeBtn, 'aria-disabled', String(tiltUnavailable));

      const statusText = formatTiltStatusText(tiltEnabled, tiltStatus);
      this.tiltStatusEl.textContent = statusText;
      this.tiltStatusEl.classList.toggle('sg-hidden', statusText.length === 0);
      const isWarn =
        tiltStatus === 'denied' ||
        tiltStatus === 'insecure' ||
        tiltStatus === 'no-sensor' ||
        tiltStatus === 'unsupported';
      const tone = tiltStatus === 'active' ? 'ok' : isWarn ? 'warn' : '';
      this.tiltStatusEl.dataset.tone = tone;
    }

    if (this.tiltFeedbackPending) {
      if (tiltStatus === 'active') {
        this.tiltFeedbackPending = false;
      } else if (
        tiltStatus === 'denied' ||
        tiltStatus === 'insecure' ||
        tiltStatus === 'no-sensor' ||
        tiltStatus === 'unsupported'
      ) {
        this.tiltFeedbackPending = false;
        const msg = formatTiltStatusText(tiltEnabled, tiltStatus);
        if (overlayMode === 'playing' && msg.length > 0) {
          this.showTiltWarningRibbon(msg);
        }
      }
    }

    // 5. Wipeout Tumble Banner
    const wipeoutActive = simState.skierState === 'wipeout';
    if (wipeoutActive !== this.lastWipeoutActive) {
      this.lastWipeoutActive = wipeoutActive;
      this.wipeoutBannerEl.classList.toggle('sg-hidden', !wipeoutActive);
    }
    if (wipeoutActive) {
      const prog = 1 - computeRatio01(simState.wipeoutTimerSec, simState.wipeoutDurationSec);
      const wipeoutWidth = `${Math.round(prog * 1000) / 10}%`;
      if (wipeoutWidth !== this.lastWipeoutWidth) {
        this.lastWipeoutWidth = wipeoutWidth;
        this.wipeoutFillEl.style.width = wipeoutWidth;
      }
    }

    // 7. Perimeter Notification Timers + Lazy Onboarding Hint
    if (overlayMode === 'playing' && !simState.paused) {
      this.activePlaySec += dt;
      this.stepNotifications(dt);
    }

    const hintVisible =
      overlayMode === 'playing' &&
      !simState.paused &&
      !hasSteered &&
      this.activePlaySec >= LAZY_HINT_DELAY_SEC;
    if (hintVisible !== this.lastHintVisible) {
      this.lastHintVisible = hintVisible;
      this.hintPillEl.classList.toggle('sg-hidden', !hintVisible);
    }
    if (hintVisible) {
      const hintText = formatControlsHint(tiltStatus === 'active');
      if (hintText !== this.lastHintText) {
        this.lastHintText = hintText;
        this.hintPillEl.textContent = hintText;
      }
    }

    // 8. Telemetry Panel
    if (telemetryVisible !== this.lastTelemetryVisible) {
      this.lastTelemetryVisible = telemetryVisible;
      this.telemetryEl.classList.toggle('sg-hidden', !telemetryVisible);
    }
    if (telemetryVisible) {
      this.updateTelemetryPanel(data);
    }

    // 9. Start / Pause / GameOver Overlay
    this.updateOverlay(data);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    for (let i = 0; i < this.unsubscribers.length; i++) {
      this.unsubscribers[i]!();
    }
    this.unsubscribers.length = 0;

    for (let i = 0; i < this.skierClickHandlers.length; i++) {
      const entry = this.skierClickHandlers[i]!;
      entry.btn.removeEventListener('click', entry.handler);
    }
    this.skierClickHandlers.length = 0;

    this.tiltBtn.removeEventListener('click', this.onTiltToggleClick);
    this.dragModeBtn.removeEventListener('click', this.onDragModeClick);
    this.tiltModeBtn.removeEventListener('click', this.onTiltModeClick);
    this.snowBtn.removeEventListener('click', this.onSnowClick);
    this.debugBtn.removeEventListener('click', this.onDebugClick);
    this.statsBtn.removeEventListener('click', this.onStatsClick);
    this.modalSnowBtn.removeEventListener('click', this.onSnowClick);
    this.modalDebugBtn.removeEventListener('click', this.onDebugClick);
    this.modalStatsBtn.removeEventListener('click', this.onStatsClick);
    this.pauseBtn.removeEventListener('click', this.onPauseClick);
    this.primaryActionBtn.removeEventListener('click', this.onPrimaryActionClick);
    this.restartActionBtn.removeEventListener('click', this.onRestartActionClick);

    if (this.rootEl.parentElement === this.mountEl) {
      this.mountEl.removeChild(this.rootEl);
    }
  }

  private showTiltWarningRibbon(message: string): void {
    this.ribbonTimerSec = 2.4;
    this.ribbonEl.dataset.tone = 'warning';
    this.ribbonPrimaryEl.textContent = 'TILT UNAVAILABLE';
    this.ribbonDetailEl.textContent = message;
    this.ribbonComboEl.classList.add('sg-hidden');
    this.ribbonEl.classList.remove('sg-hidden');
    this.ribbonEl.classList.add('sg-ribbon-visible');
    this.ribbonBumpToggle = this.triggerBump(this.ribbonEl, this.ribbonBumpToggle);
  }

  private pushPickupBurst(ev: SimEventMap['PRESENT_PICKED_UP']): void {
    const isGold = ev.presentDefId === 'gift_golden';
    if (this.pickupTimerSec > 0 && this.pickupTone !== 'stumble') {
      this.pickupAccumPoints += ev.pickupPoints;
      this.pickupAccumCount += 1;
      this.pickupHasGolden = this.pickupHasGolden || isGold;
    } else {
      this.pickupAccumPoints = ev.pickupPoints;
      this.pickupAccumCount = 1;
      this.pickupHasGolden = isGold;
    }

    const chip = formatPickupBurstChip(
      this.pickupAccumPoints,
      this.pickupAccumCount,
      this.pickupHasGolden,
    );
    this.pickupTimerSec = PICKUP_CHIP_DURATION_SEC;
    if (this.pickupTone !== chip.tone) {
      this.pickupTone = chip.tone;
      this.pickupChipEl.dataset.tone = chip.tone;
    }
    this.pickupPointsEl.textContent = chip.pointsText;
    this.pickupStarEl.classList.toggle('sg-hidden', !chip.hasGolden);
    this.pickupCountEl.textContent = chip.countText;
    this.pickupCountEl.classList.toggle('sg-hidden', chip.countText.length === 0);

    this.pickupChipEl.classList.remove('sg-hidden');
    this.pickupChipEl.classList.add('sg-chip-visible');
    this.pickupBumpToggle = this.triggerBump(this.pickupChipEl, this.pickupBumpToggle);
  }

  private showDeliveryRibbon(ev: SimEventMap['PRESENT_DELIVERED']): void {
    const ribbon = formatDeliveryRibbon(ev);
    this.ribbonTimerSec = ribbon.durationSec;
    this.ribbonEl.dataset.tone = 'delivery';
    this.ribbonPrimaryEl.textContent = ribbon.pointsText;
    this.ribbonDetailEl.textContent = ribbon.detailText;
    this.ribbonComboEl.textContent = ribbon.comboText;
    this.ribbonComboEl.classList.toggle('sg-hidden', ribbon.comboText.length === 0);

    this.ribbonEl.classList.remove('sg-hidden');
    this.ribbonEl.classList.add('sg-ribbon-visible');
    this.ribbonBumpToggle = this.triggerBump(this.ribbonEl, this.ribbonBumpToggle);
  }

  private showCreatureAlert(ev: SimEventMap['CREATURE_TELEGRAPH']): void {
    const beacon = formatCreatureEdgeBeacon(ev);
    if (beacon.side === 'left') {
      this.edgeLeftDistEl.textContent = beacon.distanceText;
      this.edgeLeftTimerSec = beacon.durationSec;
      this.edgeLeftEl.classList.remove('sg-hidden');
      this.edgeLeftEl.classList.add('sg-edge-active');
      return;
    }

    if (beacon.side === 'right') {
      this.edgeRightDistEl.textContent = beacon.distanceText;
      this.edgeRightTimerSec = beacon.durationSec;
      this.edgeRightEl.classList.remove('sg-hidden');
      this.edgeRightEl.classList.add('sg-edge-active');
      return;
    }

    // Center ahead: use the single-slot top broadcast ribbon (never blocking center sightline)
    this.ribbonTimerSec = beacon.durationSec;
    this.ribbonEl.dataset.tone = 'warning';
    this.ribbonPrimaryEl.textContent = `▲ ${beacon.creatureName}`;
    this.ribbonDetailEl.textContent = beacon.distanceText;
    this.ribbonComboEl.classList.add('sg-hidden');
    this.ribbonEl.classList.remove('sg-hidden');
    this.ribbonEl.classList.add('sg-ribbon-visible');
    this.ribbonBumpToggle = this.triggerBump(this.ribbonEl, this.ribbonBumpToggle);

    if (ev.showEdgeIndicator) {
      this.edgeLeftDistEl.textContent = beacon.distanceText;
      this.edgeRightDistEl.textContent = beacon.distanceText;
      this.edgeLeftTimerSec = 1.1;
      this.edgeRightTimerSec = 1.1;
      this.edgeLeftEl.classList.remove('sg-hidden');
      this.edgeRightEl.classList.remove('sg-hidden');
      this.edgeLeftEl.classList.add('sg-edge-active');
      this.edgeRightEl.classList.add('sg-edge-active');
    }
  }

  private showStumbleChip(ev: SimEventMap['PLAYER_WIPEOUT']): void {
    const stumble = formatStumbleChip(ev);
    if (!stumble) return;

    this.pickupAccumPoints = 0;
    this.pickupAccumCount = 0;
    this.pickupHasGolden = false;
    this.pickupTimerSec = stumble.durationSec;
    if (this.pickupTone !== 'stumble') {
      this.pickupTone = 'stumble';
      this.pickupChipEl.dataset.tone = 'stumble';
    }
    this.pickupPointsEl.textContent = stumble.text;
    this.pickupStarEl.classList.add('sg-hidden');
    this.pickupCountEl.classList.add('sg-hidden');
    this.pickupChipEl.classList.remove('sg-hidden');
    this.pickupChipEl.classList.add('sg-chip-visible');
    this.pickupBumpToggle = this.triggerBump(this.pickupChipEl, this.pickupBumpToggle);

    this.stumbleFlashTimerSec = STUMBLE_FLASH_DURATION_SEC;
    this.stumbleFlashEl.classList.add('sg-stumble-active');
  }

  private stepNotifications(dt: number): void {
    if (this.pickupTimerSec > 0) {
      this.pickupTimerSec -= dt;
      if (this.pickupTimerSec <= 0.16 && this.pickupChipEl.classList.contains('sg-chip-visible')) {
        this.pickupChipEl.classList.remove('sg-chip-visible');
      }
      if (this.pickupTimerSec <= 0) {
        this.pickupTimerSec = 0;
        this.pickupAccumPoints = 0;
        this.pickupAccumCount = 0;
        this.pickupHasGolden = false;
        this.pickupTone = '';
        this.pickupChipEl.classList.add('sg-hidden');
      }
    }

    if (this.ribbonTimerSec > 0) {
      this.ribbonTimerSec -= dt;
      if (this.ribbonTimerSec <= 0.18 && this.ribbonEl.classList.contains('sg-ribbon-visible')) {
        this.ribbonEl.classList.remove('sg-ribbon-visible');
      }
      if (this.ribbonTimerSec <= 0) {
        this.ribbonTimerSec = 0;
        this.ribbonEl.classList.add('sg-hidden');
      }
    }

    if (this.stageAnnounceTimerSec > 0) {
      this.stageAnnounceTimerSec = Math.max(0, this.stageAnnounceTimerSec - dt);
      if (this.stageAnnounceTimerSec === 0) {
        this.stagePillEl.classList.remove('sg-stage-announce');
      }
    }

    if (this.edgeLeftTimerSec > 0) {
      this.edgeLeftTimerSec -= dt;
      if (this.edgeLeftTimerSec <= 0.16 && this.edgeLeftEl.classList.contains('sg-edge-active')) {
        this.edgeLeftEl.classList.remove('sg-edge-active');
      }
      if (this.edgeLeftTimerSec <= 0) {
        this.edgeLeftTimerSec = 0;
        this.edgeLeftEl.classList.add('sg-hidden');
      }
    }

    if (this.edgeRightTimerSec > 0) {
      this.edgeRightTimerSec -= dt;
      if (this.edgeRightTimerSec <= 0.16 && this.edgeRightEl.classList.contains('sg-edge-active')) {
        this.edgeRightEl.classList.remove('sg-edge-active');
      }
      if (this.edgeRightTimerSec <= 0) {
        this.edgeRightTimerSec = 0;
        this.edgeRightEl.classList.add('sg-hidden');
      }
    }

    if (this.stumbleFlashTimerSec > 0) {
      this.stumbleFlashTimerSec = Math.max(0, this.stumbleFlashTimerSec - dt);
      if (this.stumbleFlashTimerSec === 0) {
        this.stumbleFlashEl.classList.remove('sg-stumble-active');
      }
    }
  }

  private triggerBump(el: HTMLElement, useA: boolean): boolean {
    const next = !useA;
    el.classList.remove('sg-bump-a', 'sg-bump-b');
    el.classList.add(next ? 'sg-bump-a' : 'sg-bump-b');
    return next;
  }

  private updateTelemetryPanel(data: GameUIUpdateData): void {
    const { profiler, renderStats, leakStatus, simState } = data;
    const fpsStr = profiler.fps.toFixed(1);
    const frameStr = `${profiler.frameMs.toFixed(2)} / ${profiler.avgFrameMs.toFixed(2)} ms`;
    const timingsStr = `${profiler.simMs.toFixed(2)} / ${profiler.renderMs.toFixed(2)} / ${profiler.streamMs.toFixed(2)}`;
    const drawsStr = `${renderStats.drawCalls} / ${formatTrianglesCount(renderStats.triangles)}`;
    const chunksStr = `${renderStats.activeChunks} / ${renderStats.queuedChunks}`;
    const rebaseStr = `${simState.rebase.rebaseCount}`;
    const objsStr = `${renderStats.activeObjects} (${renderStats.cachedObjects} cached)`;
    const resStr = `${renderStats.activeResources} (${renderStats.cachedResources} cached)`;
    const geoTexStr = `${renderStats.geometries} / ${renderStats.textures}`;
    const leakStr = formatLeakCheckSummary(leakStatus);

    const key = `${fpsStr}|${frameStr}|${timingsStr}|${drawsStr}|${chunksStr}|${rebaseStr}|${objsStr}|${resStr}|${geoTexStr}|${leakStr}`;
    if (key === this.lastTelemetryTextKey) return;
    this.lastTelemetryTextKey = key;

    this.teleFpsEl.textContent = fpsStr;
    this.teleFrameEl.textContent = frameStr;
    this.teleTimingsEl.textContent = timingsStr;
    this.teleDrawsEl.textContent = drawsStr;
    this.teleChunksEl.textContent = chunksStr;
    this.teleRebasesEl.textContent = rebaseStr;
    this.teleObjsEl.textContent = objsStr;
    this.teleResEl.textContent = resStr;
    this.teleGeoTexEl.textContent = geoTexStr;
    this.teleLeakEl.textContent = leakStr;
    this.teleLeakEl.classList.toggle('sg-leak-ok', leakStatus.hasRun && leakStatus.totalLeaks === 0);
    this.teleLeakEl.classList.toggle('sg-leak-bad', leakStatus.hasRun && leakStatus.totalLeaks > 0);
  }

  private updateOverlay(data: GameUIUpdateData): void {
    const { overlayMode, simState } = data;
    if (simState.skierId !== this.lastSelectedSkierId) {
      this.lastSelectedSkierId = simState.skierId;
      for (const [id, btn] of this.skierButtons) {
        btn.dataset.selected = String(id === simState.skierId);
      }
    }

    if (overlayMode !== this.lastOverlayMode) {
      this.lastOverlayMode = overlayMode;
      const showOverlay = overlayMode !== 'playing';
      this.overlayEl.classList.toggle('sg-hidden', !showOverlay);
      this.pauseBtn.dataset.paused = String(overlayMode === 'paused');
      this.setAttr(this.pauseBtn, 'aria-label', overlayMode === 'paused' ? 'Resume' : 'Pause');
      this.modalTogglesEl.classList.toggle('sg-hidden', overlayMode !== 'paused');

      if (overlayMode === 'start') {
        this.overlayKickerEl.textContent = 'Alpine Gift Courier';
        this.overlayTitleEl.textContent = 'Endless Mountain';
        this.overlaySubEl.textContent =
          'Carve past boulders & bears, stack presents, and toss them to waiting children!';
        this.summaryStripEl.classList.add('sg-hidden');
        this.primaryActionBtn.textContent = 'Start Skiing';
        this.restartActionBtn.classList.add('sg-hidden');
      } else if (overlayMode === 'paused') {
        this.overlayKickerEl.textContent = 'Paused';
        this.overlayTitleEl.textContent = 'Catch Your Breath';
        this.overlaySubEl.textContent =
          'Switch skiers mid-run, toggle storm conditions, or jump right back onto the slope.';
        this.summaryStripEl.classList.remove('sg-hidden');
        this.primaryActionBtn.textContent = 'Resume';
        this.restartActionBtn.classList.remove('sg-hidden');
      } else if (overlayMode === 'gameover') {
        this.overlayKickerEl.textContent = 'Run Complete';
        this.overlayTitleEl.textContent = 'Final Scorecard';
        this.overlaySubEl.textContent = 'Great carving! Pick a skier and hit the slopes again.';
        this.summaryStripEl.classList.remove('sg-hidden');
        this.primaryActionBtn.textContent = 'Play Again';
        this.restartActionBtn.classList.add('sg-hidden');
      }
    }

    if (overlayMode === 'paused' || overlayMode === 'gameover') {
      const summaryKey = `${simState.score}|${Math.floor(simState.distanceM)}|${simState.deliveredTotal}|${simState.highCombo}`;
      if (summaryKey !== this.lastSummaryKey) {
        this.lastSummaryKey = summaryKey;
        this.summaryScoreEl.textContent = formatScore(simState.score);
        this.summaryDistEl.textContent = formatDistanceM(simState.distanceM);
        this.summaryDeliveredEl.textContent = `${simState.deliveredTotal}`;
        this.summaryComboEl.textContent = `${simState.highCombo}`;
      }
    }
  }

  private setAttr(el: HTMLElement, name: string, value: string): void {
    if (typeof el.setAttribute === 'function') {
      el.setAttribute(name, value);
    }
  }

  private makeToggleButton(
    doc: Document,
    label: string,
    className: string,
    onClick: () => void,
  ): HTMLButtonElement {
    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = className;
    btn.textContent = label;
    btn.dataset.active = 'false';
    this.setAttr(btn, 'aria-pressed', 'false');
    btn.addEventListener('click', onClick);
    return btn;
  }

  private addTelemetryRow(doc: Document, parent: HTMLElement, label: string): HTMLSpanElement {
    const row = doc.createElement('div');
    row.className = 'sg-tele-row';
    const key = doc.createElement('span');
    key.className = 'sg-tele-key';
    key.textContent = label;
    const val = doc.createElement('span');
    val.className = 'sg-tele-val';
    val.textContent = '—';
    row.append(key, val);
    parent.appendChild(row);
    return val;
  }

  private addSummaryBox(doc: Document, parent: HTMLElement, label: string): HTMLDivElement {
    const box = doc.createElement('div');
    box.className = 'sg-summary-stat';
    const lbl = doc.createElement('div');
    lbl.className = 'sg-summary-stat-label';
    lbl.textContent = label;
    const val = doc.createElement('div');
    val.className = 'sg-summary-stat-val';
    val.textContent = '0';
    box.append(lbl, val);
    parent.appendChild(box);
    return val;
  }
}
