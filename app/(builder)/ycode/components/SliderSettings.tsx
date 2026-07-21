'use client';

/**
 * Slider Settings Component
 *
 * Settings panel for slider layers, shown when any slider-family layer is selected.
 * Walks up the tree to find the root slider layer and reads/writes settings there.
 */

import React, { useState, useMemo, useCallback, useEffect } from 'react';

import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import Icon from '@/components/ui/icon';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import SettingsPanel from './SettingsPanel';
import ToggleGroup from './ToggleGroup';

import { addChildToLayerTree, findAncestorByName, getCollectionVariable } from '@/lib/layer-utils';
import { isSliderLayerName, DEFAULT_SLIDER_SETTINGS, createSlideLayer } from '@/lib/templates/utilities';
import { EFFECTS_WITH_PER_VIEW, resolveResponsiveNumber, writeResponsiveNumber } from '@/lib/slider-utils';
import { BREAKPOINTS } from '@/lib/breakpoint-utils';
import { slidePrev, slideNext } from '@/hooks/use-canvas-slider';
import { useEditorStore } from '@/stores/useEditorStore';
import { usePagesStore } from '@/stores/usePagesStore';
import { useComponentsStore } from '@/stores/useComponentsStore';
import { useCollectionLayerStore } from '@/stores/useCollectionLayerStore';
import {
  MULTI_ASSET_COLLECTION_ID,
  MULTI_ASSET_VIRTUAL_FIELDS,
  isMultipleAssetField,
  isVirtualAssetField,
} from '@/lib/collection-field-utils';
import { isFieldVariable } from '@/lib/variable-utils';
import type { FieldGroup } from '@/lib/collection-field-utils';
import type { FieldVariable, Layer, SliderSettings as SliderSettingsType, SwiperAnimationEffect, SliderLoopMode, SliderPaginationType } from '@/types';

interface SliderSettingsProps {
  layer: Layer | null;
  onLayerUpdate: (layerId: string, updates: Partial<Layer>) => void;
  allLayers: Layer[];
  /**
   * Field groups (incl. ancestor + page collection fields) used to detect
   * whether any multi-image fields are reachable — needed to enable/disable
   * the multi-image-field source. Regular collection source is always available.
   */
  fieldGroups?: FieldGroup[];
}

/**
 * Slider content source for the slides loop:
 * - `static`: hand-authored slides
 * - `collection`: loop over items of a regular collection
 * - `multi_asset`: loop over assets of a multi-image (multi-asset) field
 */
type SliderSource = 'static' | 'collection' | 'multi_asset';

const ANIMATION_EFFECTS: { label: string; value: SwiperAnimationEffect }[] = [
  { label: 'Slide', value: 'slide' },
  { label: 'Fade', value: 'fade' },
  { label: 'Cube', value: 'cube' },
  { label: 'Flip', value: 'flip' },
  { label: 'Coverflow', value: 'coverflow' },
  { label: 'Cards', value: 'cards' },
];

const EASING_OPTIONS: { label: string; value: string; icon: 'ease-linear' | 'ease-in' | 'ease-in-out' | 'ease-out' }[] = [
  { label: 'Linear', value: 'ease-linear', icon: 'ease-linear' },
  { label: 'Ease in', value: 'ease-in', icon: 'ease-in' },
  { label: 'Ease in out', value: 'ease-in-out', icon: 'ease-in-out' },
  { label: 'Ease out', value: 'ease-out', icon: 'ease-out' },
];

export default function SliderSettings({ layer, onLayerUpdate, allLayers, fieldGroups }: SliderSettingsProps) {
  const [isOpen, setIsOpen] = useState(true);
  const [isContentOpen, setIsContentOpen] = useState(true);

  // Find the root slider layer: either the current layer or an ancestor
  const sliderLayer = useMemo((): Layer | null => {
    if (!layer) return null;
    if (layer.name === 'slider') return layer;
    if (isSliderLayerName(layer.name)) {
      return findAncestorByName(allLayers, layer.id, 'slider');
    }
    return null;
  }, [layer, allLayers]);

  const sliderLayerId = sliderLayer?.id ?? '';
  const handlePrev = useCallback(() => slidePrev(sliderLayerId), [sliderLayerId]);
  const handleNext = useCallback(() => slideNext(sliderLayerId), [sliderLayerId]);

  const currentPageId = useEditorStore((state) => state.currentPageId);
  const editingComponentId = useEditorStore((state) => state.editingComponentId);
  const editingComponentVariantId = useEditorStore((state) => state.editingComponentVariantId);
  const setSliderSnapCount = useEditorStore((state) => state.setSliderSnapCount);
  const addLayerWithId = usePagesStore((state) => state.addLayerWithId);
  const updateComponentDraft = useComponentsStore((state) => state.updateComponentDraft);
  const setSelectedLayerId = useEditorStore((state) => state.setSelectedLayerId);
  const activeBreakpoint = useEditorStore((state) => state.activeBreakpoint);
  const clearLayerData = useCollectionLayerStore((state) => state.clearLayerData);

  // Inner slides wrapper and the first slide inside it (the loop template when CMS-bound)
  const slidesLayer = useMemo(() => sliderLayer?.children?.find(c => c.name === 'slides') ?? null, [sliderLayer]);
  const templateSlide = useMemo(() => slidesLayer?.children?.find(c => c.name === 'slide') ?? null, [slidesLayer]);
  const templateSlideCollection = templateSlide ? getCollectionVariable(templateSlide) : null;
  const isMultiAssetSource = templateSlideCollection?.source_field_type === 'multi_asset';
  const isCmsSource = !!templateSlideCollection;

  // Slider settings, resolved for the active breakpoint. Per view / per group are
  // responsive, so their inputs reflect (and write to) the breakpoint currently
  // selected in the builder's viewport switcher.
  const settings: SliderSettingsType = { ...DEFAULT_SLIDER_SETTINGS, ...sliderLayer?.settings?.slider };
  const perViewValue = resolveResponsiveNumber(settings.groupSlide, activeBreakpoint, 1);
  const perGroupValue = Math.min(resolveResponsiveNumber(settings.slidesPerGroup, activeBreakpoint, 1), perViewValue);
  const breakpointLabel = BREAKPOINTS.find(bp => bp.value === activeBreakpoint)?.label ?? '';

  // Local draft state lets users freely type/clear the number inputs without the
  // controlled value snapping back; valid values commit on change, blur clamps.
  const [perViewInput, setPerViewInput] = useState(String(perViewValue));
  const [perGroupInput, setPerGroupInput] = useState(String(perGroupValue));
  useEffect(() => { setPerViewInput(String(perViewValue)); }, [perViewValue]);
  useEffect(() => { setPerGroupInput(String(perGroupValue)); }, [perGroupValue]);

  // The multi-image field option is only enabled if at least one such field
  // is reachable from this slider's context (page or ancestor collections).
  const hasMultiImageFields = useMemo<boolean>(() => {
    if (!fieldGroups) return false;
    return fieldGroups.some(group =>
      group.fields.some(f => f.type === 'image' && isMultipleAssetField(f))
    );
  }, [fieldGroups]);

  const handleAddSlide = useCallback(() => {
    if (!sliderLayer || !slidesLayer) return;
    const slideNumber = (slidesLayer.children?.length ?? 0) + 1;
    const slide = createSlideLayer(`Slide ${slideNumber}`, '/ycode/layouts/assets/placeholder-2.webp');
    if (!slide) return;

    // When editing a component, write to the component draft — not the page store,
    // whose tree doesn't contain the slider being edited (would silently no-op).
    if (editingComponentId) {
      const drafts = useComponentsStore.getState().componentDrafts[editingComponentId];
      if (!drafts) return;
      const variantId = editingComponentVariantId && drafts[editingComponentVariantId]
        ? editingComponentVariantId
        : Object.keys(drafts)[0];
      if (!variantId) return;
      const newLayers = addChildToLayerTree(drafts[variantId], slidesLayer.id, slide);
      updateComponentDraft(editingComponentId, variantId, newLayers);
    } else {
      if (!currentPageId) return;
      addLayerWithId(currentPageId, slidesLayer.id, slide);
    }
    requestAnimationFrame(() => setSelectedLayerId(slide.id));
  }, [currentPageId, editingComponentId, editingComponentVariantId, sliderLayer, slidesLayer, addLayerWithId, updateComponentDraft, setSelectedLayerId]);

  /**
   * Switch slides content source between static, regular collection, and CMS multi-image.
   *
   * On 'multi_asset': mark the template slide as a (still-unbound) multi-asset
   * collection and pre-bind its background to the virtual `__asset_url` field.
   * The actual multi-image field is then chosen by selecting the slide and
   * using the standard CMS section in the right sidebar — once bound, the
   * background renders without any extra step.
   *
   * On 'collection': mark the template slide as a regular (still-unbound)
   * collection layer. The actual collection is then chosen by selecting the
   * slide and using the standard CMS section in the right sidebar; child
   * layers are bound to fields the same way as inside any CMS list.
   *
   * On 'static': clear the collection binding and any orphaned virtual-asset
   * background (it would have no context outside CMS mode).
   */
  const handleSourceChange = useCallback((source: SliderSource) => {
    if (!slidesLayer || !templateSlide) return;

    // Helper: collapse multiple slides down to just the (CMS) template.
    const commitTemplate = (updatedTemplate: Layer) => {
      if ((slidesLayer.children?.length ?? 0) > 1) {
        onLayerUpdate(slidesLayer.id, { children: [updatedTemplate] });
      } else {
        onLayerUpdate(templateSlide.id, { variables: updatedTemplate.variables });
      }
    };

    if (source === 'multi_asset') {
      const currentBgVar = templateSlide.variables?.backgroundImage?.src;
      const isCustomCmsBinding = !!(
        currentBgVar
        && isFieldVariable(currentBgVar)
        && currentBgVar.data.field_id
        && !isVirtualAssetField(currentBgVar.data.field_id)
      );

      // Virtual asset field values live in per-iteration item data only,
      // so always use source='collection' for the binding.
      const nextBackgroundImage = isCustomCmsBinding
        ? templateSlide.variables?.backgroundImage
        : {
          src: {
            type: 'field' as const,
            data: {
              field_id: MULTI_ASSET_VIRTUAL_FIELDS.URL,
              relationships: [],
              field_type: 'image' as const,
              source: 'collection' as const,
              collection_layer_id: templateSlide.id,
            },
          } satisfies FieldVariable,
        };

      const updatedTemplateSlide: Layer = {
        ...templateSlide,
        variables: {
          ...templateSlide.variables,
          collection: {
            id: MULTI_ASSET_COLLECTION_ID,
            source_field_type: 'multi_asset',
          },
          backgroundImage: nextBackgroundImage,
        },
      };

      clearLayerData(templateSlide.id);
      commitTemplate(updatedTemplateSlide);
      return;
    }

    if (source === 'collection') {
      // Drop any virtual-asset background — only valid in multi_asset mode.
      const nextVars = { ...templateSlide.variables };
      const bgSrc = nextVars.backgroundImage?.src;
      if (bgSrc && isFieldVariable(bgSrc) && bgSrc.data.field_id && isVirtualAssetField(bgSrc.data.field_id)) {
        delete nextVars.backgroundImage;
      }

      // Empty collection id — user picks the collection via the standard CMS section.
      const updatedTemplateSlide: Layer = {
        ...templateSlide,
        variables: {
          ...nextVars,
          collection: { id: '' },
        },
      };

      clearLayerData(templateSlide.id);
      commitTemplate(updatedTemplateSlide);
      return;
    }

    // 'static'
    const nextVars = { ...templateSlide.variables };
    delete nextVars.collection;
    const bgSrc = nextVars.backgroundImage?.src;
    if (bgSrc && isFieldVariable(bgSrc) && bgSrc.data.field_id && isVirtualAssetField(bgSrc.data.field_id)) {
      delete nextVars.backgroundImage;
    }
    onLayerUpdate(templateSlide.id, {
      variables: Object.keys(nextVars).length > 0 ? nextVars : undefined,
    });

    // Clear stale collection data and snap count so pagination dots reset
    clearLayerData(templateSlide.id);
    if (sliderLayer) {
      setSliderSnapCount(sliderLayer.id, 0);
    }
  }, [slidesLayer, templateSlide, onLayerUpdate, sliderLayer, clearLayerData, setSliderSnapCount]);

  // Guard: only render for slider-family layers
  if (!layer || !sliderLayer) return null;
  if (!isSliderLayerName(layer.name)) return null;

  // Content panel (Source select) only appears on the root slider — keeps the
  // intermediate `slides` wrapper clean and routes per-slide CMS binding to the
  // standard CMS section in the right sidebar.
  const showContentPanel = layer.name === 'slider';
  const sourceValue: SliderSource = !isCmsSource
    ? 'static'
    : isMultiAssetSource ? 'multi_asset' : 'collection';

  const updateSetting = (key: keyof SliderSettingsType, value: SliderSettingsType[keyof SliderSettingsType]) => {
    onLayerUpdate(sliderLayer.id, {
      settings: {
        ...sliderLayer.settings,
        slider: { ...settings, [key]: value },
      },
    });
  };

  const updateSettings = (patch: Partial<SliderSettingsType>) => {
    onLayerUpdate(sliderLayer.id, {
      settings: {
        ...sliderLayer.settings,
        slider: { ...settings, ...patch },
      },
    });
  };

  return (
    <>
      {showContentPanel && (
        <SettingsPanel
          title="Content"
          isOpen={isContentOpen}
          onToggle={() => setIsContentOpen(!isContentOpen)}
        >
          <div className="grid grid-cols-3 items-center">
            <Label variant="muted">Source</Label>
            <div className="col-span-2">
              <Select
                value={sourceValue}
                onValueChange={(v) => handleSourceChange(v as SliderSource)}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="static">
                    <Icon name="slides" className="size-3" /> Slides
                  </SelectItem>
                  <SelectItem value="collection">
                    <Icon name="database" className="size-3" /> Collection
                  </SelectItem>
                  <SelectItem value="multi_asset" disabled={!hasMultiImageFields}>
                    <Icon name="image" className="size-3" /> Multi-image field
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </SettingsPanel>
      )}

      <SettingsPanel
        title="Slider"
        isOpen={isOpen}
        onToggle={() => setIsOpen(!isOpen)}
        action={
          <div className="flex items-center gap-1">
            {!isCmsSource && (
              <Button
                variant="secondary"
                size="xs"
                className="size-6 p-0"
                onClick={handleAddSlide}
                aria-label="Add slide"
              >
                <Icon name="plus" className="size-2.5" />
              </Button>
            )}
          <Button
            variant="secondary"
            size="xs"
            className="size-6 p-0"
            onClick={handlePrev}
            aria-label="Previous slide"
          >
            <Icon name="slide-button-prev" className="size-2.5" />
          </Button>
          <Button
            variant="secondary"
            size="xs"
            className="size-6 p-0"
            onClick={handleNext}
            aria-label="Next slide"
          >
            <Icon name="slide-button-next" className="size-2.5" />
          </Button>
        </div>
      }
      >
      <div className="flex flex-col gap-2.5">
        {/* Animation */}
        <div className="grid grid-cols-3 items-center">
          <Label variant="muted">Effect</Label>
          <div className="col-span-2">
            <Select
              value={settings.animationEffect}
              onValueChange={(v) => {
                const effect = v as SwiperAnimationEffect;
                if (!EFFECTS_WITH_PER_VIEW.has(effect)) {
                  updateSettings({ animationEffect: effect, groupSlide: 1, slidesPerGroup: 1 });
                } else {
                  updateSetting('animationEffect', effect);
                }
              }}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ANIMATION_EFFECTS.map((effect) => (
                  <SelectItem key={effect.value} value={effect.value}>
                    {effect.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* Slides per view - responsive, only for effects that support multiple slides */}
        {EFFECTS_WITH_PER_VIEW.has(settings.animationEffect) && (
          <div className="grid grid-cols-3 items-center">
            <Label variant="muted" title={`Slides visible per view on ${breakpointLabel}`}>Per view</Label>
            <div className="col-span-2 *:w-full">
              <InputGroup>
                <InputGroupInput
                  stepper
                  step="1"
                  min="1"
                  max="10"
                  value={perViewInput}
                  onChange={(e) => {
                    const raw = e.target.value.replace(/[^0-9]/g, '');
                    setPerViewInput(raw);
                    const n = parseInt(raw, 10);
                    if (!Number.isNaN(n) && n >= 1 && n <= 10) {
                      const patch: Partial<SliderSettingsType> = {
                        groupSlide: writeResponsiveNumber(settings.groupSlide, activeBreakpoint, n),
                      };
                      if (perGroupValue > n) {
                        patch.slidesPerGroup = writeResponsiveNumber(settings.slidesPerGroup, activeBreakpoint, n);
                      }
                      updateSettings(patch);
                    }
                  }}
                  onBlur={() => {
                    const parsed = parseInt(perViewInput, 10);
                    const clamped = Number.isNaN(parsed) ? 1 : Math.min(Math.max(parsed, 1), 10);
                    setPerViewInput(String(clamped));
                    const patch: Partial<SliderSettingsType> = {
                      groupSlide: writeResponsiveNumber(settings.groupSlide, activeBreakpoint, clamped),
                    };
                    if (perGroupValue > clamped) {
                      patch.slidesPerGroup = writeResponsiveNumber(settings.slidesPerGroup, activeBreakpoint, clamped);
                    }
                    updateSettings(patch);
                  }}
                />
                <InputGroupAddon align="inline-end" className="text-xs text-muted-foreground">
                  items
                </InputGroupAddon>
              </InputGroup>
            </div>
          </div>
        )}

        {/* Slides per group - responsive, only when slidesPerView > 1 */}
        {EFFECTS_WITH_PER_VIEW.has(settings.animationEffect) && perViewValue > 1 && (
          <div className="grid grid-cols-3 items-center">
            <Label variant="muted" title={`Slides advanced per step on ${breakpointLabel}`}>Per group</Label>
            <div className="col-span-2 *:w-full">
              <InputGroup>
                <InputGroupInput
                  stepper
                  step="1"
                  min="1"
                  max={perViewValue}
                  value={perGroupInput}
                  onChange={(e) => {
                    const raw = e.target.value.replace(/[^0-9]/g, '');
                    setPerGroupInput(raw);
                    const n = parseInt(raw, 10);
                    if (!Number.isNaN(n) && n >= 1 && n <= perViewValue) {
                      updateSetting('slidesPerGroup', writeResponsiveNumber(settings.slidesPerGroup, activeBreakpoint, n));
                    }
                  }}
                  onBlur={() => {
                    const parsed = parseInt(perGroupInput, 10);
                    const clamped = Number.isNaN(parsed) ? 1 : Math.min(Math.max(parsed, 1), perViewValue);
                    setPerGroupInput(String(clamped));
                    updateSetting('slidesPerGroup', writeResponsiveNumber(settings.slidesPerGroup, activeBreakpoint, clamped));
                  }}
                />
                <InputGroupAddon align="inline-end" className="text-xs text-muted-foreground">
                  items
                </InputGroupAddon>
              </InputGroup>
            </div>
          </div>
        )}

        <div className="grid grid-cols-3 items-center">
          <Label variant="muted">Easing</Label>
          <div className="col-span-2">
            <Select
              value={settings.easing}
              onValueChange={(v) => updateSetting('easing', v)}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {EASING_OPTIONS.map((ease) => (
                  <SelectItem key={ease.value} value={ease.value}>
                    <span className="flex items-center gap-2">
                      <Icon name={ease.icon} className="size-3" />
                      {ease.label}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="grid grid-cols-3">
          <Label variant="muted">Duration</Label>
          <div className="col-span-2 *:w-full">
            <InputGroup>
              <InputGroupInput
                stepper
                step="0.1"
                min="0"
                value={settings.duration}
                onChange={(e) => {
                  const val = e.target.value.replace(/[^0-9.]/g, '');
                  updateSetting('duration', val);
                }}
                onBlur={() => {
                  const num = parseFloat(settings.duration);
                  if (!Number.isNaN(num) && num >= 0) {
                    updateSetting('duration', String(num));
                  } else {
                    updateSetting('duration', '0.5');
                  }
                }}
                placeholder="0"
              />
              <InputGroupAddon align="inline-end" className="text-xs text-muted-foreground">
                sec
              </InputGroupAddon>
            </InputGroup>
          </div>
        </div>

        <div className="grid grid-cols-3 items-center">
          <Label variant="muted">Autoplay</Label>
          <div className="col-span-2 flex gap-2">
            <div className={settings.autoplay ? 'min-w-0 flex-1' : 'w-full'}>
              <Select
                value={settings.autoplay ? 'every' : 'disabled'}
                onValueChange={(v) => updateSetting('autoplay', v === 'every')}
              >
                <SelectTrigger className="w-full">
                  <SelectValue>
                    {settings.autoplay ? 'Every' : 'Disabled'}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent align="start" className="min-w-37">
                  <SelectItem value="disabled">Disabled</SelectItem>
                  <SelectItem value="every">Every X seconds</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {settings.autoplay && (
              <InputGroup className="min-w-0 flex-1">
                <InputGroupInput
                  stepper
                  step="0.1"
                  min="0"
                  value={settings.delay}
                  onChange={(e) => {
                    const val = e.target.value.replace(/[^0-9.]/g, '');
                    updateSetting('delay', val);
                  }}
                  onBlur={() => {
                    const num = parseFloat(settings.delay);
                    if (!Number.isNaN(num) && num >= 0) {
                      updateSetting('delay', String(num));
                    } else {
                      updateSetting('delay', '3');
                    }
                  }}
                  placeholder="0"
                />
                <InputGroupAddon align="inline-end" className="text-xs text-muted-foreground">
                  sec
                </InputGroupAddon>
              </InputGroup>
            )}
          </div>
        </div>

        {/* Loop */}
        <div className="grid grid-cols-3 items-center">
          <Label variant="muted">Loop</Label>
          <div className="col-span-2 *:w-full">
            <ToggleGroup
              options={[
                { label: 'None', value: 'none' },
                { icon: 'loop-alternate', value: 'loop' },
                { icon: 'loop-repeat', value: 'rewind' },
              ]}
              value={settings.loop}
              onChange={(v) => updateSetting('loop', v as SliderLoopMode)}
            />
          </div>
        </div>

        <div className="grid grid-cols-3 items-center">
          <Label variant="muted">Pagination</Label>
          <div className="col-span-2">
            <Select
              value={
                !settings.pagination
                  ? 'none'
                  : settings.paginationType === 'fraction'
                    ? 'fraction'
                    : settings.paginationClickable
                      ? 'clickable'
                      : 'passive'
              }
              onValueChange={(v) => {
                if (v === 'none') {
                  updateSettings({ pagination: false });
                } else {
                  updateSettings({
                    pagination: true,
                    paginationType: v === 'fraction' ? 'fraction' : 'bullets',
                    paginationClickable: v === 'clickable',
                  });
                }
              }}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">
                  <span className="flex items-center gap-2">
                    <Icon name="none" className="size-3" />
                    Hidden
                  </span>
                </SelectItem>
                <SelectItem value="passive">
                  <span className="flex items-center gap-2">
                    <Icon name="slide-bullets" className="size-3" />
                    Passive bullets
                  </span>
                </SelectItem>
                <SelectItem value="clickable">
                  <span className="flex items-center gap-2">
                    <Icon name="slide-bullets" className="size-3" />
                    Clickable bullets
                  </span>
                </SelectItem>
                <SelectItem value="fraction">
                  <span className="flex items-center gap-2">
                    <Icon name="slide-fraction" className="size-3" />
                    Fraction
                  </span>
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* Behavior toggles */}
        <div className="grid grid-cols-3 items-start gap-2">
          <Label variant="muted">Behavior</Label>
          <div className="col-span-2 flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <Checkbox
                id="slider-navigation"
                checked={settings.navigation}
                onCheckedChange={(checked) => updateSetting('navigation', checked)}
              />
              <Label
                variant="muted"
                htmlFor="slider-navigation"
                className="cursor-pointer"
              >
                Show navigation
              </Label>
            </div>
            {settings.autoplay && (
              <div className="flex items-center gap-2">
                <Checkbox
                  id="slider-pause-hover"
                  checked={settings.pauseOnHover}
                  onCheckedChange={(checked) => updateSetting('pauseOnHover', checked)}
                />
                <Label
                  variant="muted"
                  htmlFor="slider-pause-hover"
                  className="cursor-pointer"
                >
                  Pause on hover
                </Label>
              </div>
            )}
            {EFFECTS_WITH_PER_VIEW.has(settings.animationEffect) && perViewValue > 1 && (
              <div className="flex items-center gap-2">
                <Checkbox
                  id="slider-centered"
                  checked={settings.centered}
                  onCheckedChange={(checked) => updateSetting('centered', checked)}
                />
                <Label
                  variant="muted"
                  htmlFor="slider-centered"
                  className="cursor-pointer"
                >
                  Centered mode
                </Label>
              </div>
            )}
            <div className="flex items-center gap-2">
              <Checkbox
                id="slider-touch"
                checked={settings.touchEvents}
                onCheckedChange={(checked) => {
                  updateSettings(
                    checked ? { touchEvents: true } : { touchEvents: false, slideToClicked: false }
                  );
                }}
              />
              <Label
                variant="muted"
                htmlFor="slider-touch"
                className="cursor-pointer"
              >
                Touch events
              </Label>
            </div>
            {settings.touchEvents && (
              <div className="flex items-center gap-2">
                <Checkbox
                  id="slider-slide-to-clicked"
                  checked={settings.slideToClicked}
                  onCheckedChange={(checked) => updateSetting('slideToClicked', checked)}
                />
                <Label
                  variant="muted"
                  htmlFor="slider-slide-to-clicked"
                  className="cursor-pointer"
                >
                  Slide on touch
                </Label>
              </div>
            )}
            <div className="flex items-center gap-2">
              <Checkbox
                id="slider-mousewheel"
                checked={settings.mousewheel}
                onCheckedChange={(checked) => updateSetting('mousewheel', checked)}
              />
              <Label
                variant="muted"
                htmlFor="slider-mousewheel"
                className="cursor-pointer"
              >
                Mousewheel
              </Label>
            </div>
          </div>
        </div>
      </div>
      </SettingsPanel>
    </>
  );
}
