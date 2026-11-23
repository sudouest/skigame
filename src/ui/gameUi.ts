import { SKIERS } from '../content/characters';
import type { EventBus, Unsubscribe } from '../core/eventBus';
import type { SimEventMap } from '../sim/contracts';
import {
  computeRatio01,
  formatCreatureTelegraphPopup,
  formatDeliveryPopup,
  formatDistanceM,
  formatForkEnteredPopup,
  formatLeakCheckSummary,
  formatMultiplier,
  formatPickupPopup,
  formatScore,
  formatSkierCardInfo,
  formatStageDisplay,
  formatTrianglesCount,
  formatWipeoutEventPopup,
  type PopupDescriptor,
} from './hudFormatting';
import { HUD_STYLES } from './styles';
import type { GameUICallbacks, GameUIUpdateData, OverlayMode } from './types';

const POPUP_POOL_SIZE = 5;
const LAZY_HINT_DELAY_SEC = 8.0;

interface PopupSlot {
  readonly root: HTMLDivElement;
  readonly titleEl: HTMLDivElement;
  readonly subEl: HTMLDivElement;
  active: boolean;
  remainingSec: number;
  lastTone: string;
}

/**
 * Responsive cartoon HTML/CSS overlay HUD, Start/Pause/Skier Select modal,
 * debug/mode toggle pills, pooled floating event popups, and Telemetry HUD.
 * Communicates strictly via `ReadonlySimState`, `EventBus<SimEventMap>`, `ProfilerSnapshot`,
 * and plain UI interfaces (zero `three` imports, zero private sim/render reach-ins).
 */
export class GameUI {
  private readonly mountEl: HTMLElement;
  private readonly callbacks: GameUICallbacks;
  private readonly rootEl: HTMLDivElement;
  private readonly unsubscribers: Unsubscribe[] = [];

  // Score & Combo
  private readonly scoreValueEl: HTMLSpanElement;
  private readonly comboBadgeEl: HTMLSpanElement;
  private readonly comboFillEl: HTMLDivElement;

  // Bag & Delivered
  private readonly bagCardEl: HTMLDivElement;
  private readonly bagCountEl: HTMLSpanElement;
  private readonly deliveredSubEl: HTMLSpanElement;

  // Stage & Distance
  private readonly stagePillEl: HTMLDivElement;
  private readonly stageBadgeEl: HTMLSpanElement;
  private readonly stageNameEl: HTMLSpanElement;
  private readonly distancePillEl: HTMLDivElement;

  // Toggle Buttons
  private readonly snowBtn: HTMLButtonElement;
  private readonly debugBtn: HTMLButtonElement;
  private readonly statsBtn: HTMLButtonElement;
  private readonly pauseBtn: HTMLButtonElement;

  // Center Banners & Pooled Popups
  private readonly forkBannerEl: HTMLDivElement;
  private readonly forkHeaderEl: HTMLDivElement;
  private readonly forkLeftEl: HTMLDivElement;
  private readonly forkLeftBadgeEl: HTMLSpanElement;
  private readonly forkLeftNameEl: HTMLSpanElement;
  private readonly forkRightEl: HTMLDivElement;
  private readonly forkRightBadgeEl: HTMLSpanElement;
  private readonly forkRightNameEl: HTMLSpanElement;

  private readonly wipeoutBannerEl: HTMLDivElement;
  private readonly wipeoutSubEl: HTMLDivElement;
  private readonly wipeoutFillEl: HTMLDivElement;

  private readonly popupSlots: PopupSlot[] = [];
  private readonly edgeLeftEl: HTMLDivElement;
  private readonly edgeRightEl: HTMLDivElement;
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
  private lastOverlayMode: OverlayMode | '' = '';
  private lastSelectedSkierId = '';
  private lastForkActive = false;
  private lastForkHeader = '';
  private lastForkLeftId = '';
  private lastForkRightId = '';
  private lastWipeoutActive = false;
  private lastWipeoutWidth = '';
  private lastHintVisible = false;
  private lastTelemetryVisible = false;
  private lastTelemetryTextKey = '';
  private lastSummaryKey = '';
  private disposed = false;

  // Bound event listeners
  private readonly onSnowClick = (): void => {
    this.snowBtn.blur();
    this.callbacks.onToggleBlizzard();
  };
  private readonly onDebugClick = (): void => {
    this.debugBtn.blur();
    this.callbacks.onToggleDebugDraw();
  };
  private readonly onStatsClick = (): void => {
    this.statsBtn.blur();
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

    // 1. Top Bar
    const topBar = doc.createElement('div');
    topBar.className = 'sg-topbar';

    const topLeft = doc.createElement('div');
    topLeft.className = 'sg-cluster';

    // Score & Combo Card
    const scorePill = doc.createElement('div');
    scorePill.className = 'sg-pill sg-score-card';

    const scoreRow = doc.createElement('div');
    scoreRow.className = 'sg-score-row';
    const scoreMeta = doc.createElement('div');
    const scoreLabel = doc.createElement('div');
    scoreLabel.className = 'sg-score-label';
    scoreLabel.textContent = 'Score';
    this.scoreValueEl = doc.createElement('span');
    this.scoreValueEl.className = 'sg-score-value';
    this.scoreValueEl.textContent = '0';
    scoreMeta.append(scoreLabel, this.scoreValueEl);

    this.comboBadgeEl = doc.createElement('span');
    this.comboBadgeEl.className = 'sg-combo-badge sg-combo-idle';
    this.comboBadgeEl.textContent = 'x1';
    scoreRow.append(scoreMeta, this.comboBadgeEl);

    const comboTrack = doc.createElement('div');
    comboTrack.className = 'sg-bar-track';
    this.comboFillEl = doc.createElement('div');
    this.comboFillEl.className = 'sg-bar-fill';
    comboTrack.appendChild(this.comboFillEl);
    scorePill.append(scoreRow, comboTrack);

    // Bag & Delivered Card
    this.bagCardEl = doc.createElement('div');
    this.bagCardEl.className = 'sg-pill sg-bag-card';
    this.bagCardEl.innerHTML =
      '<svg class="sg-bag-icon" viewBox="0 0 24 24" aria-hidden="true">' +
      '<rect x="3" y="8" width="18" height="13" rx="3" fill="#ef476f" stroke="#0f172a" stroke-width="2.2"/>' +
      '<rect x="2" y="5" width="20" height="5" rx="2" fill="#ffd166" stroke="#0f172a" stroke-width="2.2"/>' +
      '<rect x="10.5" y="5" width="3" height="16" fill="#fffdf7"/>' +
      '</svg>';
    const bagNumbers = doc.createElement('div');
    bagNumbers.className = 'sg-bag-numbers';
    this.bagCountEl = doc.createElement('span');
    this.bagCountEl.className = 'sg-bag-count';
    this.bagCountEl.textContent = '0 / 12';
    this.deliveredSubEl = doc.createElement('span');
    this.deliveredSubEl.className = 'sg-delivered-sub';
    this.deliveredSubEl.textContent = 'Delivered: 0';
    bagNumbers.append(this.bagCountEl, this.deliveredSubEl);
    this.bagCardEl.appendChild(bagNumbers);

    topLeft.append(scorePill, this.bagCardEl);

    // Top Right: Stage, Distance, Toggles
    const topRight = doc.createElement('div');
    topRight.className = 'sg-cluster-right';

    const stageRow = doc.createElement('div');
    stageRow.className = 'sg-stage-row';

    this.stagePillEl = doc.createElement('div');
    this.stagePillEl.className = 'sg-pill sg-stage-pill';
    this.stageBadgeEl = doc.createElement('span');
    this.stageBadgeEl.className = 'sg-stage-badge';
    this.stageNameEl = doc.createElement('span');
    this.stageNameEl.className = 'sg-stage-name';
    this.stagePillEl.append(this.stageBadgeEl, this.stageNameEl);

    this.distancePillEl = doc.createElement('div');
    this.distancePillEl.className = 'sg-pill sg-dist-pill';
    this.distancePillEl.textContent = '0 m';

    stageRow.append(this.stagePillEl, this.distancePillEl);

    const togglesRow = doc.createElement('div');
    togglesRow.className = 'sg-toggles';
    this.snowBtn = this.makeToggleButton(doc, 'Snow [B]', 'sg-btn-snow', this.onSnowClick);
    this.debugBtn = this.makeToggleButton(doc, 'Debug [G]', 'sg-btn-debug', this.onDebugClick);
    this.statsBtn = this.makeToggleButton(doc, 'Stats [P]', 'sg-btn-stats', this.onStatsClick);
    this.pauseBtn = this.makeToggleButton(doc, 'Pause [Esc]', 'sg-btn-pause', this.onPauseClick);
    togglesRow.append(this.snowBtn, this.debugBtn, this.statsBtn, this.pauseBtn);

    topRight.append(stageRow, togglesRow);
    topBar.append(topLeft, topRight);

    // 2. Center Banners & Pooled Event Popups
    const centerStack = doc.createElement('div');
    centerStack.className = 'sg-center-stack';

    this.forkBannerEl = doc.createElement('div');
    this.forkBannerEl.className = 'sg-fork-banner sg-hidden';
    this.forkHeaderEl = doc.createElement('div');
    this.forkHeaderEl.className = 'sg-fork-header';
    const forkChoices = doc.createElement('div');
    forkChoices.className = 'sg-fork-choices';

    this.forkLeftEl = doc.createElement('div');
    this.forkLeftEl.className = 'sg-fork-side';
    this.forkLeftBadgeEl = doc.createElement('span');
    this.forkLeftBadgeEl.className = 'sg-stage-badge';
    this.forkLeftNameEl = doc.createElement('span');
    const leftArrow = doc.createElement('span');
    leftArrow.textContent = '◀';
    this.forkLeftEl.append(leftArrow, this.forkLeftBadgeEl, this.forkLeftNameEl);

    this.forkRightEl = doc.createElement('div');
    this.forkRightEl.className = 'sg-fork-side sg-fork-side-right';
    this.forkRightBadgeEl = doc.createElement('span');
    this.forkRightBadgeEl.className = 'sg-stage-badge';
    this.forkRightNameEl = doc.createElement('span');
    const rightArrow = doc.createElement('span');
    rightArrow.textContent = '▶';
    this.forkRightEl.append(rightArrow, this.forkRightBadgeEl, this.forkRightNameEl);

    forkChoices.append(this.forkLeftEl, this.forkRightEl);
    this.forkBannerEl.append(this.forkHeaderEl, forkChoices);

    this.wipeoutBannerEl = doc.createElement('div');
    this.wipeoutBannerEl.className = 'sg-wipeout-banner sg-hidden';
    const wipeoutTitle = doc.createElement('div');
    wipeoutTitle.className = 'sg-wipeout-title';
    wipeoutTitle.textContent = 'WIPEOUT!';
    this.wipeoutSubEl = doc.createElement('div');
    this.wipeoutSubEl.className = 'sg-wipeout-sub';
    this.wipeoutSubEl.textContent = 'Tumbling... Back on skis soon!';
    const wipeoutBar = doc.createElement('div');
    wipeoutBar.className = 'sg-wipeout-bar';
    this.wipeoutFillEl = doc.createElement('div');
    this.wipeoutFillEl.className = 'sg-wipeout-fill';
    wipeoutBar.appendChild(this.wipeoutFillEl);
    this.wipeoutBannerEl.append(wipeoutTitle, this.wipeoutSubEl, wipeoutBar);

    const popupPoolEl = doc.createElement('div');
    popupPoolEl.className = 'sg-popup-pool';
    for (let i = 0; i < POPUP_POOL_SIZE; i++) {
      const root = doc.createElement('div');
      root.className = 'sg-popup sg-hidden';
      const titleEl = doc.createElement('div');
      titleEl.className = 'sg-popup-title';
      const subEl = doc.createElement('div');
      subEl.className = 'sg-popup-sub';
      root.append(titleEl, subEl);
      popupPoolEl.appendChild(root);
      this.popupSlots.push({
        root,
        titleEl,
        subEl,
        active: false,
        remainingSec: 0,
        lastTone: '',
      });
    }

    centerStack.append(this.forkBannerEl, this.wipeoutBannerEl, popupPoolEl);

    // 3. Peripheral Creature Edge Alerts & Lazy Hint
    this.edgeLeftEl = doc.createElement('div');
    this.edgeLeftEl.className = 'sg-edge-pulse sg-edge-left';
    this.edgeRightEl = doc.createElement('div');
    this.edgeRightEl.className = 'sg-edge-pulse sg-edge-right';

    this.hintPillEl = doc.createElement('div');
    this.hintPillEl.className = 'sg-hint-pill sg-hidden';
    this.hintPillEl.textContent =
      'Carve: A/D, Arrows, or Drag • Jump: Space or Tap • Brake: S or 2-Finger Hold';

    // 4. Telemetry HUD Panel
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

    // 5. Start / Pause / Skier Select Overlay
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
      'Collect gifts, dodge pines & bears, and deliver to waiting children for combo chains!';

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
      btn.addEventListener('click', () => {
        btn.blur();
        this.callbacks.onSelectSkier(info.id);
      });
      this.skierButtons.set(info.id, btn);
      skierGrid.appendChild(btn);
    }

    const controlsBox = doc.createElement('div');
    controlsBox.className = 'sg-controls-box';
    controlsBox.innerHTML =
      '<div class="sg-controls-line"><strong>Desktop:</strong> A/D or Arrows carve · Space/W/Up jump · S/Down brake</div>' +
      '<div class="sg-controls-line"><strong>Touch:</strong> Drag horizontally to carve · Tap or swipe up jump · 2-finger brake</div>' +
      '<div class="sg-controls-line"><strong>Toggles:</strong> [B] Blizzard · [G] 3D Debug · [P] Telemetry · [Esc] Pause</div>';

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
      controlsBox,
      actionsRow,
    );
    this.overlayEl.appendChild(modal);

    this.rootEl.append(
      topBar,
      centerStack,
      this.edgeLeftEl,
      this.edgeRightEl,
      this.hintPillEl,
      this.telemetryEl,
      this.overlayEl,
    );
    this.mountEl.appendChild(this.rootEl);

    // Subscribe to simulation EventBus cues
    this.unsubscribers.push(
      eventBus.on('PRESENT_PICKED_UP', (ev) => {
        this.pushPopup(formatPickupPopup(ev));
      }),
      eventBus.on('PRESENT_DELIVERED', (ev) => {
        this.pushPopup(formatDeliveryPopup(ev));
      }),
      eventBus.on('FORK_ENTERED', (ev) => {
        this.pushPopup(formatForkEnteredPopup(ev));
      }),
      eventBus.on('CREATURE_TELEGRAPH', (ev) => {
        this.pushPopup(formatCreatureTelegraphPopup(ev));
        if (ev.edgeSide === 'left') {
          this.edgeLeftTimerSec = 1.4;
        } else if (ev.edgeSide === 'right') {
          this.edgeRightTimerSec = 1.4;
        } else if (ev.showEdgeIndicator) {
          this.edgeLeftTimerSec = 1.1;
          this.edgeRightTimerSec = 1.1;
        }
      }),
      eventBus.on('PLAYER_WIPEOUT', (ev) => {
        const desc = formatWipeoutEventPopup(ev);
        if (desc) {
          this.pushPopup(desc);
        }
      }),
    );
  }

  resetRunState(): void {
    this.activePlaySec = 0;
    this.edgeLeftTimerSec = 0;
    this.edgeRightTimerSec = 0;
    this.edgeLeftEl.classList.remove('sg-edge-active');
    this.edgeRightEl.classList.remove('sg-edge-active');

    for (let i = 0; i < this.popupSlots.length; i++) {
      const slot = this.popupSlots[i]!;
      slot.active = false;
      slot.remainingSec = 0;
      slot.root.classList.remove('sg-popup-visible');
      slot.root.classList.add('sg-hidden');
    }
  }

  update(data: GameUIUpdateData, frameDtSec: number): void {
    if (this.disposed) return;

    const { simState, overlayMode, hasSteered, debugDrawEnabled, telemetryVisible } = data;
    const dt = Number.isFinite(frameDtSec) && frameDtSec > 0 ? frameDtSec : 0;

    // 1. Score & Combo
    const scoreText = formatScore(simState.score);
    if (scoreText !== this.lastScoreText) {
      this.lastScoreText = scoreText;
      this.scoreValueEl.textContent = scoreText;
    }

    const comboActive = simState.comboTimerSec > 0 || simState.comboMultiplier > 1;
    const comboText = formatMultiplier(simState.comboMultiplier);
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
    const bagText = `${simState.carriedCount} / ${simState.maxCarryCapacity}`;
    if (bagText !== this.lastBagText) {
      this.lastBagText = bagText;
      this.bagCountEl.textContent = bagText;
    }
    const bagFull = simState.maxCarryCapacity > 0 && simState.carriedCount >= simState.maxCarryCapacity;
    if (bagFull !== this.lastBagFull) {
      this.lastBagFull = bagFull;
      this.bagCardEl.classList.toggle('sg-bag-full', bagFull);
    }
    const deliveredText = `Delivered: ${simState.deliveredTotal}`;
    if (deliveredText !== this.lastDeliveredText) {
      this.lastDeliveredText = deliveredText;
      this.deliveredSubEl.textContent = deliveredText;
    }

    // 3. Stage Pill & Distance
    if (simState.activeStageId !== this.lastStageId) {
      this.lastStageId = simState.activeStageId;
      const stage = formatStageDisplay(simState.activeStageId);
      this.stagePillEl.dataset.stage = stage.id;
      this.stageBadgeEl.textContent = stage.badgeSymbol;
      this.stageBadgeEl.style.backgroundColor = stage.badgeColor;
      this.stageNameEl.textContent = stage.name;
    }

    const distanceText = formatDistanceM(simState.distanceM);
    if (distanceText !== this.lastDistanceText) {
      this.lastDistanceText = distanceText;
      this.distancePillEl.textContent = distanceText;
    }

    // 4. Toggle Pills
    const blizzardOn = simState.activeWeather.blizzardEnabled;
    if (blizzardOn !== this.lastSnowActive) {
      this.lastSnowActive = blizzardOn;
      this.snowBtn.dataset.active = String(blizzardOn);
    }
    if (debugDrawEnabled !== this.lastDebugActive) {
      this.lastDebugActive = debugDrawEnabled;
      this.debugBtn.dataset.active = String(debugDrawEnabled);
    }
    if (telemetryVisible !== this.lastStatsActive) {
      this.lastStatsActive = telemetryVisible;
      this.statsBtn.dataset.active = String(telemetryVisible);
    }

    // 5. Upcoming Fork Telegraph Banner
    const forkActive = simState.upcomingFork.active;
    if (forkActive !== this.lastForkActive) {
      this.lastForkActive = forkActive;
      this.forkBannerEl.classList.toggle('sg-hidden', !forkActive);
    }
    if (forkActive) {
      const forkHeader = `FORK IN ${Math.ceil(simState.upcomingFork.distanceM)} m`;
      if (forkHeader !== this.lastForkHeader) {
        this.lastForkHeader = forkHeader;
        this.forkHeaderEl.textContent = forkHeader;
      }
      const leftId = simState.upcomingFork.leftStageId ?? 'sunny-blue';
      if (leftId !== this.lastForkLeftId) {
        this.lastForkLeftId = leftId;
        const leftStage = formatStageDisplay(leftId);
        this.forkLeftEl.dataset.stage = leftStage.id;
        this.forkLeftBadgeEl.textContent = leftStage.badgeSymbol;
        this.forkLeftBadgeEl.style.backgroundColor = leftStage.badgeColor;
        this.forkLeftNameEl.textContent =
          leftStage.multiplier > 1
            ? `${leftStage.name} (${leftStage.multiplierLabel})`
            : leftStage.name;
      }
      const rightId = simState.upcomingFork.rightStageId ?? 'icy-black';
      if (rightId !== this.lastForkRightId) {
        this.lastForkRightId = rightId;
        const rightStage = formatStageDisplay(rightId);
        this.forkRightEl.dataset.stage = rightStage.id;
        this.forkRightBadgeEl.textContent = rightStage.badgeSymbol;
        this.forkRightBadgeEl.style.backgroundColor = rightStage.badgeColor;
        this.forkRightNameEl.textContent =
          rightStage.multiplier > 1
            ? `${rightStage.name} (${rightStage.multiplierLabel})`
            : rightStage.name;
      }
    }

    // 6. Wipeout Tumble Banner
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

    // 7. Pooled Floating Popups & Edge Alerts + Lazy Onboarding Hint
    if (overlayMode === 'playing' && !simState.paused) {
      this.activePlaySec += dt;
      this.stepPopupsAndEdges(dt);
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

    this.snowBtn.removeEventListener('click', this.onSnowClick);
    this.debugBtn.removeEventListener('click', this.onDebugClick);
    this.statsBtn.removeEventListener('click', this.onStatsClick);
    this.pauseBtn.removeEventListener('click', this.onPauseClick);
    this.primaryActionBtn.removeEventListener('click', this.onPrimaryActionClick);
    this.restartActionBtn.removeEventListener('click', this.onRestartActionClick);

    if (this.rootEl.parentElement === this.mountEl) {
      this.mountEl.removeChild(this.rootEl);
    }
  }

  private stepPopupsAndEdges(dt: number): void {
    for (let i = 0; i < this.popupSlots.length; i++) {
      const slot = this.popupSlots[i]!;
      if (!slot.active) continue;
      slot.remainingSec -= dt;
      if (slot.remainingSec <= 0.18 && slot.root.classList.contains('sg-popup-visible')) {
        slot.root.classList.remove('sg-popup-visible');
      }
      if (slot.remainingSec <= 0) {
        slot.active = false;
        slot.remainingSec = 0;
        slot.root.classList.add('sg-hidden');
      }
    }

    if (this.edgeLeftTimerSec > 0) {
      this.edgeLeftTimerSec = Math.max(0, this.edgeLeftTimerSec - dt);
      this.edgeLeftEl.classList.toggle('sg-edge-active', this.edgeLeftTimerSec > 0);
    }
    if (this.edgeRightTimerSec > 0) {
      this.edgeRightTimerSec = Math.max(0, this.edgeRightTimerSec - dt);
      this.edgeRightEl.classList.toggle('sg-edge-active', this.edgeRightTimerSec > 0);
    }
  }

  private pushPopup(desc: PopupDescriptor): void {
    let target: PopupSlot | null = null;
    for (let i = 0; i < this.popupSlots.length; i++) {
      const candidate = this.popupSlots[i]!;
      if (!candidate.active) {
        target = candidate;
        break;
      }
      if (!target || candidate.remainingSec < target.remainingSec) {
        target = candidate;
      }
    }
    if (!target) return;

    target.active = true;
    target.remainingSec = desc.durationSec;
    if (target.lastTone !== desc.tone) {
      target.lastTone = desc.tone;
      target.root.dataset.tone = desc.tone;
    }
    target.titleEl.textContent = desc.title;
    target.subEl.textContent = desc.subtitle;
    target.root.classList.remove('sg-hidden');
    target.root.classList.add('sg-popup-visible');
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
      this.pauseBtn.textContent = overlayMode === 'paused' ? 'Resume [Esc]' : 'Pause [Esc]';

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

  private makeToggleButton(
    doc: Document,
    label: string,
    extraClass: string,
    onClick: () => void,
  ): HTMLButtonElement {
    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = `sg-toggle-btn ${extraClass}`;
    btn.textContent = label;
    btn.dataset.active = 'false';
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
