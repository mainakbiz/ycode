/**
 * FieldFormDialog Component
 *
 * Reusable dialog for creating and editing collection fields.
 * Consolidates the field form logic used in CMS.tsx for both modes.
 */
'use client';

import React, { useState, useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import Icon from '@/components/ui/icon';
import { Spinner } from '@/components/ui/spinner';
import { Checkbox } from '@/components/ui/checkbox';
import { FIELD_TYPES_BY_CATEGORY, ASSET_FIELD_TYPES, supportsDefaultValue, isAssetFieldType, getFileManagerCategory, getAssetFieldLabel, type FieldType } from '@/lib/collection-field-utils';
import { parseMultiReferenceValue } from '@/lib/collection-utils';
import { clampDateInputValue } from '@/lib/date-format-utils';
import { useCollectionsStore } from '@/stores/useCollectionsStore';
import { useEditorStore } from '@/stores/useEditorStore';
import { useAssetsStore } from '@/stores/useAssetsStore';
import ExpandableRichTextEditor from './ExpandableRichTextEditor';
import CollectionLinkFieldInput from './CollectionLinkFieldInput';
import ColorFieldInput from './ColorFieldInput';
import AssetFieldCard from './AssetFieldCard';
import type { Asset, AssetCategoryFilter, CollectionField, CollectionFieldData, CollectionFieldType } from '@/types';

export interface FieldFormData {
  name: string;
  type: FieldType;
  default: string;
  reference_collection_id?: string | null;
  data?: CollectionFieldData;
}

interface FieldFormDialogProps {
  /** null = create mode, CollectionField = edit mode */
  field?: CollectionField | null;
  currentCollectionId?: string;
  onSubmit: (data: FieldFormData) => void | Promise<void>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export default function FieldFormDialog({
  field,
  currentCollectionId,
  onSubmit,
  open,
  onOpenChange,
}: FieldFormDialogProps) {
  // Snapshot the field when the dialog opens so content stays stable during close animation
  const stableFieldRef = useRef<CollectionField | null | undefined>(field);
  useEffect(() => {
    if (open) {
      stableFieldRef.current = field;
    }
  }, [open, field]);

  const stableField = open ? field : stableFieldRef.current;
  const mode = stableField ? 'edit' : 'create';

  // Form state
  const [fieldName, setFieldName] = useState('');
  const [fieldType, setFieldType] = useState<FieldType>('text');
  const [fieldDefault, setFieldDefault] = useState('');
  const [referenceCollectionId, setReferenceCollectionId] = useState<string | null>(null);
  const [fieldMultiple, setFieldMultiple] = useState(false);
  const [fieldOptions, setFieldOptions] = useState<{ id: string; name: string }[]>([]);
  const [countCollectionId, setCountCollectionId] = useState<string | null>(null);
  const [countFieldId, setCountFieldId] = useState<string | null>(null);
  const [hasChangedType, setHasChangedType] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Stores
  const { collections, fields: fieldsByCollectionId } = useCollectionsStore();
  const openFileManager = useEditorStore((state) => state.openFileManager);
  const getAsset = useAssetsStore((state) => state.getAsset);

  // Filter out the current collection from reference options (can't reference self)
  const availableCollections = React.useMemo(() => {
    const filtered = collections.filter(c => c.id !== currentCollectionId);

    // In edit mode, ensure the referenced collection is always in the list
    if (stableField?.reference_collection_id) {
      const refCollectionExists = filtered.some(c => c.id === stableField.reference_collection_id);
      if (!refCollectionExists) {
        const refCollection = collections.find(c => c.id === stableField.reference_collection_id);
        if (refCollection) {
          return [...filtered, refCollection];
        }
      }
    }

    return filtered;
  }, [collections, currentCollectionId, stableField?.reference_collection_id]);

  // Derived flags
  const isReferenceType = fieldType === 'reference' || fieldType === 'multi_reference';
  const isAssetType = ASSET_FIELD_TYPES.includes(fieldType);
  const isOptionType = fieldType === 'option';
  const isCountType = fieldType === 'count';
  const hasDefault = supportsDefaultValue(fieldType);

  const hasInvalidOptions = isOptionType && (() => {
    if (fieldOptions.length === 0) return true;
    const names = fieldOptions.map(o => o.name.trim());
    if (names.some(n => !n)) return true;
    const lowered = names.map(n => n.toLowerCase());
    return new Set(lowered).size !== lowered.length;
  })();

  // Collections that have at least one reference / multi_reference field
  // pointing back at the current collection — only those make sense as a
  // counting source.
  const countableCollections = React.useMemo(() => {
    if (!isCountType || !currentCollectionId) return [];
    return collections.filter(c => {
      if (c.id === currentCollectionId) return false;
      const fields = fieldsByCollectionId[c.id] || [];
      return fields.some(
        f => (f.type === 'reference' || f.type === 'multi_reference')
          && f.reference_collection_id === currentCollectionId,
      );
    });
  }, [isCountType, currentCollectionId, collections, fieldsByCollectionId]);

  // Reference fields on the picked count collection that point back at the
  // current collection.
  const countCandidateFields = React.useMemo(() => {
    if (!isCountType || !countCollectionId || !currentCollectionId) return [];
    const fields = fieldsByCollectionId[countCollectionId] || [];
    return fields.filter(
      f => (f.type === 'reference' || f.type === 'multi_reference')
        && f.reference_collection_id === currentCollectionId,
    );
  }, [isCountType, countCollectionId, currentCollectionId, fieldsByCollectionId]);

  const isSubmitDisabled =
    !fieldName.trim() ||
    (isReferenceType && !referenceCollectionId) ||
    (isCountType && (!countCollectionId || !countFieldId)) ||
    hasInvalidOptions;

  // Reset form when dialog opens
  useEffect(() => {
    if (!open) return;

    if (field) {
      setFieldName(field.name);
      if (field.type !== 'status') setFieldType(field.type);
      setFieldDefault(field.default || '');
      setReferenceCollectionId(field.reference_collection_id || null);
      setFieldMultiple(field.data?.multiple || false);
      setFieldOptions(
        Array.isArray(field.data?.options)
          ? field.data.options.map(o => ({ id: o.id, name: o.name }))
          : []
      );
      setCountCollectionId(field.data?.count?.collectionId ?? null);
      setCountFieldId(field.data?.count?.fieldId ?? null);
    } else {
      setFieldName('');
      setFieldType('text');
      setFieldDefault('');
      setReferenceCollectionId(null);
      setFieldMultiple(false);
      setFieldOptions([]);
      setCountCollectionId(null);
      setCountFieldId(null);
    }
    setHasChangedType(false);
    setIsSubmitting(false);
  }, [open, field]);

  // Clear reference collection when switching away from reference types
  useEffect(() => {
    if (hasChangedType && !isReferenceType) {
      setReferenceCollectionId(null);
    }
  }, [isReferenceType, hasChangedType]);

  // Clear multiple setting when switching away from asset types
  useEffect(() => {
    if (hasChangedType && !isAssetType) {
      setFieldMultiple(false);
    }
  }, [isAssetType, hasChangedType]);

  // Clear options when switching away from option type
  useEffect(() => {
    if (hasChangedType && !isOptionType) {
      setFieldOptions([]);
    }
  }, [isOptionType, hasChangedType]);

  // Clear count config when switching away from count type
  useEffect(() => {
    if (hasChangedType && !isCountType) {
      setCountCollectionId(null);
      setCountFieldId(null);
    }
  }, [isCountType, hasChangedType]);

  // When the picked count collection changes, drop a stale field selection
  // that no longer belongs to that collection.
  useEffect(() => {
    if (!isCountType) return;
    if (!countFieldId) return;
    const stillValid = countCandidateFields.some(f => f.id === countFieldId);
    if (!stillValid) setCountFieldId(null);
  }, [isCountType, countFieldId, countCandidateFields]);

  // Clear/reset default value when switching types
  useEffect(() => {
    if (hasChangedType) {
      if (!hasDefault) {
        setFieldDefault('');
      } else if (fieldType === 'boolean') {
        setFieldDefault('false');
      } else {
        setFieldDefault('');
      }
    }
  }, [fieldType, hasChangedType, hasDefault]);

  const handleSubmit = async () => {
    if (!fieldName.trim()) return;
    if (isReferenceType && !referenceCollectionId) return;
    if (isCountType && (!countCollectionId || !countFieldId)) return;
    if (hasInvalidOptions) return;
    if (isSubmitting) return;

    let data: CollectionFieldData | undefined;
    if (isAssetType) {
      data = { multiple: fieldMultiple };
    } else if (isOptionType) {
      data = {
        options: fieldOptions.map(o => ({ id: o.id, name: o.name.trim() })),
      };
    } else if (isCountType && countCollectionId && countFieldId) {
      data = { count: { collectionId: countCollectionId, fieldId: countFieldId } };
    }

    try {
      setIsSubmitting(true);
      await onSubmit({
        name: fieldName.trim(),
        type: fieldType,
        default: fieldDefault,
        reference_collection_id: isReferenceType ? referenceCollectionId : null,
        data,
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleAddOption = () => {
    const id = typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `opt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setFieldOptions(prev => [...prev, { id, name: '' }]);
  };

  const handleUpdateOptionName = (id: string, name: string) => {
    setFieldOptions(prev => {
      const previous = prev.find(o => o.id === id);
      if (previous && fieldDefault.trim() === previous.name.trim()) {
        setFieldDefault(name.trim());
      }
      return prev.map(o => (o.id === id ? { ...o, name } : o));
    });
  };

  const handleRemoveOption = (id: string) => {
    setFieldOptions(prev => {
      const next = prev.filter(o => o.id !== id);
      return next;
    });
    const removed = fieldOptions.find(o => o.id === id);
    if (removed && fieldDefault === removed.name.trim()) {
      setFieldDefault('');
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (isSubmitting && !next) return; onOpenChange(next); }}>
      <DialogContent className="sm:max-w-md" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>
            {mode === 'create' ? 'New field' : `Edit field "${stableField?.name}"`}
          </DialogTitle>
        </DialogHeader>

        <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); if (!isSubmitDisabled && !isSubmitting) handleSubmit(); }}>
          <div className="grid grid-cols-5 items-center gap-4">
            <Label htmlFor="field-name" className="text-right">
              Name
            </Label>
            <div className="col-span-4">
              <Input
                id="field-name"
                value={fieldName}
                onChange={(e) => setFieldName(e.target.value)}
                placeholder="Field name"
                autoComplete="off"
              />
            </div>
          </div>

          <div className="grid grid-cols-5 items-center gap-4">
            <Label htmlFor="field-type" className="text-right">
              Type
            </Label>
            <div className="col-span-4">
              <Select
                value={fieldType}
                onValueChange={(value: any) => {
                  setFieldType(value);
                  setHasChangedType(true);
                }}
                disabled={mode === 'edit'}
              >
                <SelectTrigger id="field-type" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {FIELD_TYPES_BY_CATEGORY.map((category, catIdx) => (
                    <React.Fragment key={category.id}>
                      {catIdx > 0 && <SelectSeparator />}
                      <SelectGroup>
                        {category.types.map((type) => (
                          <SelectItem key={type.value} value={type.value}>
                            <span className="flex items-center gap-2">
                              <Icon name={type.icon} className="size-3 shrink-0 opacity-60" />
                              {type.label}
                            </span>
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </React.Fragment>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Reference Collection Selector */}
          {isReferenceType && (
            <div className="grid grid-cols-5 items-center gap-4">
              <Label htmlFor="field-reference-collection" className="text-right">
                Collection
              </Label>
              <div className="col-span-4">
                <Select
                  value={referenceCollectionId || ''}
                  onValueChange={(value) => setReferenceCollectionId(value || null)}
                  disabled={mode === 'edit'}
                >
                  <SelectTrigger id="field-reference-collection" className="w-full">
                    <SelectValue placeholder="Select..." />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {availableCollections.length > 0 ? (
                        availableCollections.map((collection) => (
                          <SelectItem key={collection.id} value={collection.id}>
                            {collection.name}
                          </SelectItem>
                        ))
                      ) : (
                        <div className="px-2 py-1.5 text-sm text-muted-foreground">
                          No collections available
                        </div>
                      )}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}

          {/* Count configuration */}
          {isCountType && (
            <>
              <div className="grid grid-cols-5 items-center gap-4">
                <Label htmlFor="field-count-collection" className="text-right">
                  Collection
                </Label>
                <div className="col-span-4">
                  <Select
                    value={countCollectionId || ''}
                    onValueChange={(value) => setCountCollectionId(value || null)}
                    disabled={mode === 'edit'}
                  >
                    <SelectTrigger id="field-count-collection" className="w-full">
                      <SelectValue placeholder={countableCollections.length === 0 ? 'No collections reference this one' : 'Select collection...'} />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {countableCollections.length > 0 ? (
                          countableCollections.map((collection) => (
                            <SelectItem key={collection.id} value={collection.id}>
                              {collection.name}
                            </SelectItem>
                          ))
                        ) : (
                          <div className="px-2 py-1.5 text-sm text-muted-foreground">
                            No collections reference this one
                          </div>
                        )}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="grid grid-cols-5 items-center gap-4">
                <Label htmlFor="field-count-field" className="text-right">
                  Field
                </Label>
                <div className="col-span-4">
                  <Select
                    value={countFieldId || ''}
                    onValueChange={(value) => setCountFieldId(value || null)}
                    disabled={mode === 'edit' || !countCollectionId || countCandidateFields.length === 0}
                  >
                    <SelectTrigger id="field-count-field" className="w-full">
                      <SelectValue placeholder={!countCollectionId ? 'Pick a collection first' : countCandidateFields.length === 0 ? 'No reference fields' : 'Select field...'} />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {countCandidateFields.map((f) => (
                          <SelectItem key={f.id} value={f.id}>
                            {f.name}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </>
          )}

          {/* Multiple files toggle */}
          {isAssetType && (
            <div className="grid grid-cols-5 items-center gap-4">
              <Label htmlFor="field-multiple" className="text-right">
                Multiple
              </Label>
              <div className="col-span-4 flex items-center gap-2">
                <Checkbox
                  id="field-multiple"
                  checked={fieldMultiple}
                  onCheckedChange={(checked) => setFieldMultiple(checked === true)}
                  disabled={mode === 'edit' && stableField?.data?.multiple === true}
                />
                <Label
                  htmlFor="field-multiple"
                  className="text-xs text-muted-foreground font-normal cursor-pointer"
                >
                  Allows multiple files
                </Label>
              </div>
            </div>
          )}

          {/* Options editor */}
          {isOptionType && (
            <div className="grid grid-cols-5 items-start gap-4">
              <Label className="text-right mt-2">
                Options
              </Label>
              <div className="col-span-4 flex flex-col gap-2">
                {fieldOptions.length > 0 && (
                  <div className="flex flex-col gap-2">
                    {fieldOptions.map((option) => (
                      <div key={option.id} className="flex items-center gap-1">
                        <Input
                          value={option.name}
                          onChange={(e) => handleUpdateOptionName(option.id, e.target.value)}
                          placeholder="Option name"
                          autoComplete="off"
                          className="flex-1"
                        />
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => handleRemoveOption(option.id)}
                          aria-label="Remove option"
                        >
                          <Icon name="x" />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  className="w-fit"
                  onClick={handleAddOption}
                >
                  <Icon name="plus" className="size-3" />
                  Add option
                </Button>
              </div>
            </div>
          )}

          {/* Default value */}
          {hasDefault && (
            <div className="grid grid-cols-5 items-start gap-4">
              <Label htmlFor="field-default" className="text-right mt-2">
                Default
              </Label>
              <div className="col-span-4">
                {isAssetFieldType(fieldType) ? (
                  fieldMultiple ? (
                    <AssetDefaultMultiple
                      fieldType={fieldType}
                      value={fieldDefault}
                      onChange={setFieldDefault}
                      openFileManager={openFileManager}
                      getAsset={getAsset}
                    />
                  ) : (
                    <AssetDefaultSingle
                      fieldType={fieldType}
                      value={fieldDefault}
                      onChange={setFieldDefault}
                      openFileManager={openFileManager}
                      getAsset={getAsset}
                    />
                  )
                ) : fieldType === 'rich_text' ? (
                  <ExpandableRichTextEditor
                    value={fieldDefault}
                    onChange={setFieldDefault}
                    placeholder="Default value"
                    sheetDescription="Field default value"
                  />
                ) : fieldType === 'link' ? (
                  <CollectionLinkFieldInput
                    value={fieldDefault}
                    onChange={setFieldDefault}
                  />
                ) : fieldType === 'color' ? (
                  <ColorFieldInput
                    value={fieldDefault}
                    onChange={setFieldDefault}
                  />
                ) : fieldType === 'option' ? (
                  <Select
                    value={fieldDefault || '__none__'}
                    onValueChange={(value) => setFieldDefault(value === '__none__' ? '' : value)}
                    disabled={fieldOptions.length === 0}
                  >
                    <SelectTrigger id="field-default" className="w-full">
                      <SelectValue placeholder={fieldOptions.length === 0 ? 'Add options first' : 'Select default...'} />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectItem value="__none__">No default</SelectItem>
                        {fieldOptions
                          .filter((o) => o.name.trim().length > 0)
                          .map((option) => (
                            <SelectItem key={option.id} value={option.name.trim()}>
                              {option.name.trim()}
                            </SelectItem>
                          ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                ) : fieldType === 'boolean' ? (
                  <div className="flex items-center gap-2 h-8">
                    <Checkbox
                      id="field-default"
                      checked={fieldDefault === 'true'}
                      onCheckedChange={(checked) => setFieldDefault(checked ? 'true' : 'false')}
                    />
                    <Label
                      htmlFor="field-default"
                      className="text-xs text-muted-foreground font-normal cursor-pointer gap-1"
                    >
                      Value is set to <span className="text-foreground">{fieldDefault === 'true' ? 'YES' : 'NO'}</span>
                    </Label>
                  </div>
                ) : fieldType === 'number' ? (
                  <Input
                    id="field-default"
                    type="number"
                    value={fieldDefault}
                    onChange={(e) => setFieldDefault(e.target.value)}
                    placeholder="0"
                    autoComplete="off"
                  />
                ) : fieldType === 'date' ? (
                  <Input
                    id="field-default"
                    type="datetime-local"
                    value={fieldDefault}
                    onChange={(e) => setFieldDefault(clampDateInputValue(e.target.value))}
                    autoComplete="off"
                  />
                ) : fieldType === 'date_only' ? (
                  <Input
                    id="field-default"
                    type="date"
                    value={fieldDefault}
                    onChange={(e) => setFieldDefault(clampDateInputValue(e.target.value))}
                    autoComplete="off"
                  />
                ) : fieldType === 'email' ? (
                  <Input
                    id="field-default"
                    type="email"
                    value={fieldDefault}
                    onChange={(e) => setFieldDefault(e.target.value)}
                    placeholder="email@example.com"
                    autoComplete="off"
                  />
                ) : fieldType === 'phone' ? (
                  <Input
                    id="field-default"
                    type="tel"
                    value={fieldDefault}
                    onChange={(e) => setFieldDefault(e.target.value)}
                    placeholder="+1 (555) 000-0000"
                    autoComplete="off"
                  />
                ) : (
                  <Input
                    id="field-default"
                    value={fieldDefault}
                    onChange={(e) => setFieldDefault(e.target.value)}
                    placeholder="Default value"
                    autoComplete="off"
                  />
                )}
              </div>
            </div>
          )}

          <div className="flex justify-end gap-2 mt-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => onOpenChange(false)}
              disabled={isSubmitting}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              size="sm"
              disabled={isSubmitDisabled || isSubmitting}
            >
              {isSubmitting && <Spinner className="size-3" />}
              {mode === 'create'
                ? (isSubmitting ? 'Creating...' : 'Create field')
                : (isSubmitting ? 'Updating...' : 'Update field')}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// =============================================================================
// Asset Default Sub-Components
// =============================================================================

interface AssetDefaultProps {
  fieldType: CollectionFieldType;
  value: string;
  onChange: (value: string) => void;
  openFileManager: (onSelect?: ((asset: Asset) => void | false) | null, assetId?: string | null, category?: AssetCategoryFilter) => void;
  getAsset: (id: string) => Asset | null;
}

/** Single-asset default value picker */
function AssetDefaultSingle({ fieldType, value, onChange, openFileManager, getAsset }: AssetDefaultProps) {
  const asset = value ? getAsset(value) : null;
  const label = getAssetFieldLabel(fieldType);

  const handleSelect = () => {
    openFileManager(
      (selectedAsset) => { onChange(selectedAsset.id); },
      value || null,
      getFileManagerCategory(fieldType),
    );
  };

  if (!asset) {
    return (
      <Button
        type="button"
        variant="secondary"
        size="sm"
        className="w-fit"
        onClick={(e) => { e.stopPropagation(); handleSelect(); }}
      >
        <Icon name="plus" className="size-3" />
        Add {label}
      </Button>
    );
  }

  return (
    <div className="grid gap-2 grid-cols-[repeat(auto-fill,minmax(min(100%,320px),1fr))]">
      <AssetFieldCard
        asset={asset}
        fieldType={fieldType}
        onChangeFile={handleSelect}
        onRemove={() => onChange('')}
      />
    </div>
  );
}

/** Multiple-asset default value picker */
function AssetDefaultMultiple({ fieldType, value, onChange, openFileManager, getAsset }: AssetDefaultProps) {
  const assetIds = parseMultiReferenceValue(value);
  const label = getAssetFieldLabel(fieldType);

  const handleAdd = () => {
    openFileManager(
      (selectedAsset) => {
        if (!assetIds.includes(selectedAsset.id)) {
          onChange(JSON.stringify([...assetIds, selectedAsset.id]));
        }
      },
      null,
      getFileManagerCategory(fieldType),
    );
  };

  const handleReplace = (oldAssetId: string) => {
    openFileManager(
      (selectedAsset) => {
        onChange(JSON.stringify(assetIds.map(id => id === oldAssetId ? selectedAsset.id : id)));
      },
      oldAssetId,
      getFileManagerCategory(fieldType),
    );
  };

  const handleRemove = (assetId: string) => {
    const updated = assetIds.filter(id => id !== assetId);
    onChange(updated.length > 0 ? JSON.stringify(updated) : '');
  };

  return (
    <div className="space-y-2">
      {assetIds.length > 0 && (
        <div className="grid gap-2 grid-cols-[repeat(auto-fill,minmax(min(100%,320px),1fr))]">
          {assetIds.map((assetId) => (
            <AssetFieldCard
              key={assetId}
              asset={getAsset(assetId)}
              fieldType={fieldType}
              onChangeFile={() => handleReplace(assetId)}
              onRemove={() => handleRemove(assetId)}
            />
          ))}
        </div>
      )}
      <Button
        type="button"
        variant="secondary"
        size="sm"
        className="w-fit"
        onClick={(e) => { e.stopPropagation(); handleAdd(); }}
      >
        <Icon name="plus" className="size-3" />
        Add {label}
      </Button>
    </div>
  );
}
