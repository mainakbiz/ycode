/**
 * Shared Swiper configuration utilities used by both
 * SliderInitializer (production) and useCanvasSlider (canvas editor).
 */

import {
  Navigation,
  Pagination,
  Autoplay,
  Mousewheel,
  EffectFade,
  EffectCube,
  EffectFlip,
  EffectCoverflow,
  EffectCards,
} from 'swiper/modules';
import type { SwiperOptions } from 'swiper/types';
import type { Breakpoint, ResponsiveNumber, SliderSettings, SwiperAnimationEffect } from '@/types';

/** Desktop-first fallback chain: a breakpoint inherits from larger ones when unset */
const BREAKPOINT_FALLBACKS: Record<Breakpoint, Breakpoint[]> = {
  desktop: ['desktop'],
  tablet: ['tablet', 'desktop'],
  mobile: ['mobile', 'tablet', 'desktop'],
};

/**
 * Resolve a responsive value for a breakpoint, following the desktop-first
 * fallback chain. Plain numbers apply to every breakpoint.
 */
export function resolveResponsiveNumber(
  value: ResponsiveNumber | undefined,
  breakpoint: Breakpoint,
  fallback: number,
): number {
  if (value == null) return fallback;
  if (typeof value === 'number') return value;
  for (const bp of BREAKPOINT_FALLBACKS[breakpoint]) {
    const resolved = value[bp];
    if (typeof resolved === 'number') return resolved;
  }
  return fallback;
}

/**
 * Write a per-breakpoint value into a responsive value, collapsing to a plain
 * number when only the desktop base is set (keeps stored settings clean).
 */
export function writeResponsiveNumber(
  current: ResponsiveNumber | undefined,
  breakpoint: Breakpoint,
  next: number,
): ResponsiveNumber {
  const obj: Partial<Record<Breakpoint, number>> =
    typeof current === 'object' && current !== null ? { ...current } : {};
  if (typeof current === 'number') obj.desktop = current;
  obj[breakpoint] = next;

  const keys = Object.keys(obj) as Breakpoint[];
  if (keys.length === 1 && typeof obj.desktop === 'number') return obj.desktop;
  return obj;
}

/** Highest value a responsive number takes across all breakpoints */
export function maxResponsiveNumber(value: ResponsiveNumber | undefined, fallback: number): number {
  if (value == null) return fallback;
  if (typeof value === 'number') return value;
  const values = Object.values(value).filter((v): v is number => typeof v === 'number');
  return values.length ? Math.max(...values) : fallback;
}

/**
 * Snapshot React-applied inline CSS custom properties (e.g. --bg-img) on a
 * slider's slide elements and return a restore function. Swiper's
 * destroy(cleanStyles=true) wipes each slide's entire style attribute, which
 * strips these vars; React won't re-render to reapply them, so we restore
 * them manually after destroy.
 */
export function preserveSlideCssVars(sliderEl: HTMLElement): () => void {
  const slides = Array.from(
    sliderEl.querySelectorAll<HTMLElement>('.swiper-wrapper > .swiper-slide'),
  );
  const snapshots = slides.map((slide) => {
    const vars: Record<string, string> = {};
    for (let i = 0; i < slide.style.length; i++) {
      const prop = slide.style[i];
      if (prop.startsWith('--')) vars[prop] = slide.style.getPropertyValue(prop);
    }
    return { slide, vars };
  });

  return () => {
    for (const { slide, vars } of snapshots) {
      for (const [prop, value] of Object.entries(vars)) {
        slide.style.setProperty(prop, value);
      }
    }
  };
}

/** Effect name → Swiper module mapping */
export const EFFECT_MODULES: Partial<Record<SwiperAnimationEffect, typeof EffectFade>> = {
  fade: EffectFade,
  cube: EffectCube,
  flip: EffectFlip,
  coverflow: EffectCoverflow,
  cards: EffectCards,
};

/** Effects that support slidesPerView > 1 */
export const EFFECTS_WITH_PER_VIEW = new Set<SwiperAnimationEffect>(['slide', 'coverflow']);

/** All Swiper modules needed for production (canvas uses a subset) */
export const ALL_SWIPER_MODULES = [Navigation, Pagination, Autoplay, Mousewheel];

/**
 * Build the shared base Swiper config from slider settings.
 * Covers options common to both canvas and production.
 *
 * When `fixedBreakpoint` is set (canvas editor), per-view/per-group are resolved
 * for that single breakpoint and no responsive `breakpoints` map is emitted —
 * Swiper's window-based breakpoints can't be used there because the instance is
 * created from the builder frame (whose window width never matches the canvas
 * iframe viewport). Otherwise (production) the mobile values seed the base and
 * min-width breakpoints override at 768px (tablet) and 1024px (desktop).
 */
export function buildBaseSwiperOptions(
  settings: SliderSettings,
  fixedBreakpoint?: Breakpoint,
): SwiperOptions {
  const modules = [...ALL_SWIPER_MODULES];
  const effectKey = settings.animationEffect;
  const effectModule = EFFECT_MODULES[effectKey];

  if (effectModule) modules.push(effectModule);

  const perView = (bp: Breakpoint) => resolveResponsiveNumber(settings.groupSlide, bp, 1);
  const perGroup = (bp: Breakpoint) =>
    Math.min(resolveResponsiveNumber(settings.slidesPerGroup, bp, 1), perView(bp));

  const config: SwiperOptions = {
    modules,
    slidesPerView: perView(fixedBreakpoint ?? 'mobile'),
    slidesPerGroup: perGroup(fixedBreakpoint ?? 'mobile'),
    centeredSlides: settings.centered,
    speed: Math.round(parseFloat(settings.duration || '0.5') * 1000),
  };

  if (!fixedBreakpoint) {
    config.breakpoints = {
      768: { slidesPerView: perView('tablet'), slidesPerGroup: perGroup('tablet') },
      1024: { slidesPerView: perView('desktop'), slidesPerGroup: perGroup('desktop') },
    };
  }

  if (effectModule) {
    config.effect = effectKey as SwiperOptions['effect'];
  }

  if (settings.loop === 'loop') {
    config.loop = true;
  } else if (settings.loop === 'rewind') {
    config.rewind = true;
  }

  return config;
}

/**
 * Build the full production Swiper config (adds interactive options).
 */
export function buildProductionSwiperOptions(settings: SliderSettings): SwiperOptions {
  const config = buildBaseSwiperOptions(settings);

  config.allowTouchMove = settings.touchEvents;
  config.slideToClickedSlide = settings.slideToClicked;

  if (settings.navigation) {
    config.navigation = {
      nextEl: '[data-slider-next]',
      prevEl: '[data-slider-prev]',
    };
  }

  if (settings.pagination) {
    const isFraction = settings.paginationType === 'fraction';
    config.pagination = {
      el: isFraction ? '[data-slider-fraction]' : '[data-slider-pagination]',
      type: isFraction ? 'fraction' : 'bullets',
      clickable: settings.paginationClickable,
    };
  }

  if (settings.autoplay) {
    config.autoplay = {
      delay: Math.round(parseFloat(settings.delay || '3') * 1000),
      disableOnInteraction: false,
      pauseOnMouseEnter: settings.pauseOnHover ?? true,
    };
  }

  if (settings.mousewheel) {
    config.mousewheel = true;
  }

  return config;
}

/**
 * Build canvas-only Swiper config (all interactions disabled).
 */
export function buildCanvasSwiperOptions(
  settings: SliderSettings,
  ghostPaginationEl: HTMLElement,
  activeBreakpoint: Breakpoint,
): SwiperOptions {
  const config = buildBaseSwiperOptions(settings, activeBreakpoint);

  config.simulateTouch = false;
  config.allowTouchMove = false;
  config.navigation = { enabled: false };
  config.pagination = {
    enabled: true,
    el: ghostPaginationEl,
    type: 'fraction',
  };
  config.autoplay = false;
  config.observer = true;
  config.observeParents = true;
  config.preventInteractionOnTransition = false;

  return config;
}

/** Apply easing to the Swiper wrapper's CSS transition-timing-function */
export function applySwiperEasing(swiperEl: HTMLElement, easing: string) {
  const wrapper = swiperEl.querySelector('.swiper-wrapper') as HTMLElement | null;
  if (wrapper) {
    wrapper.style.transitionTimingFunction = easing || 'ease-in-out';
  }
}

/**
 * Configure renderBullet to use the user's bullet element as a template,
 * merging Swiper's classes with the user's design.
 * current: classes are kept on the bullet — Tailwind compiles them
 * via the @custom-variant current (&[aria-current]) directive.
 */
export function configureBulletRenderer(el: HTMLElement, config: SwiperOptions) {
  const paginationEl = el.querySelector('[data-slider-pagination]');
  if (!paginationEl || !config.pagination || typeof config.pagination !== 'object') return;
  if (config.pagination.type !== 'bullets') return;

  const bulletEl = paginationEl.querySelector('[data-layer-id]');
  if (!bulletEl) return;

  const bulletHTML = bulletEl.outerHTML;

  config.pagination.renderBullet = (_index: number, className: string) => {
    const parts = bulletHTML.split('class="');
    if (parts.length < 2) return `<span class="${className}">${bulletHTML}</span>`;
    return parts[0] + 'class="' + className + ' ' + parts[1];
  };
}

/**
 * Sync HTML attributes with Swiper's state classes so Tailwind
 * variants work natively:
 * - Active bullet gets `aria-current` → `current:` variant activates
 * - Disabled nav buttons get `aria-disabled` → `disabled:` variant activates
 */
export function syncSliderStateAttributes(swiper: InstanceType<typeof import('swiper').default>) {
  const syncBullets = () => {
    const bullets = swiper.el.querySelectorAll('.swiper-pagination-bullet');
    bullets.forEach((bullet) => {
      if (bullet.classList.contains('swiper-pagination-bullet-active')) {
        bullet.setAttribute('aria-current', 'true');
      } else {
        bullet.removeAttribute('aria-current');
      }
    });
  };

  const syncNavButtons = () => {
    const buttons = swiper.el.querySelectorAll('[data-slider-prev], [data-slider-next]');
    buttons.forEach((btn) => {
      if (btn.classList.contains('swiper-button-disabled')) {
        btn.setAttribute('aria-disabled', 'true');
      } else {
        btn.removeAttribute('aria-disabled');
      }
    });
  };

  const syncAll = () => {
    syncBullets();
    syncNavButtons();
  };

  swiper.on('init', syncAll);
  swiper.on('slideChangeTransitionEnd', syncAll);
  swiper.on('paginationUpdate', syncBullets);
  swiper.on('navigationNext', syncNavButtons);
  swiper.on('navigationPrev', syncNavButtons);
  // Re-sync nav aria-disabled when the layout changes (e.g. a responsive
  // breakpoint switches slidesPerView). Swiper updates its own disabled classes
  // on these events but not our aria bridge, so next/prev could stay visually
  // disabled after resizing from desktop to mobile.
  swiper.on('update', syncNavButtons);
  swiper.on('breakpoint', syncNavButtons);
  swiper.on('resize', syncNavButtons);
  swiper.on('toEdge', syncNavButtons);
  swiper.on('fromEdge', syncNavButtons);
  swiper.on('lock', syncNavButtons);
  swiper.on('unlock', syncNavButtons);

  // Initial sync after mount
  requestAnimationFrame(syncAll);
}

/** Load minimal Swiper CSS into an iframe document via <link> tag */
export function loadSwiperCss(doc: Document) {
  const id = 'ycode-swiper-css';
  if (doc.getElementById(id)) return;
  const link = doc.createElement('link');
  link.id = id;
  link.rel = 'stylesheet';
  link.href = '/swiper-minimal.css';
  doc.head.appendChild(link);
}
