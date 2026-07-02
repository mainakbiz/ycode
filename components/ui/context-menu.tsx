'use client';

import * as React from 'react';
import * as ContextMenuPrimitive from '@radix-ui/react-context-menu';
import { CheckIcon, ChevronRightIcon, CircleIcon } from 'lucide-react';

import { cn } from '@/lib/utils';
import Icon from '@/components/ui/icon';

/**
 * Shares the "armed" flag between {@link ContextMenuContent} and its items so a
 * single release-guard can neutralise the first pointerup after the menu opens.
 */
const ContextMenuReleaseGuard = React.createContext<React.MutableRefObject<boolean> | null>(null);

/**
 * Overrides applied when the menu is portaled into a foreign container (e.g. the
 * canvas iframe body). Neutralises typography inherited from the edited page's
 * font classes and forces a max z-index so page layers can't paint over it.
 */
const PORTAL_MENU_STYLE: React.CSSProperties = {
  fontFamily:
    'var(--font-inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif)',
  fontSize: '16px',
  fontWeight: 400,
  fontStyle: 'normal',
  lineHeight: 'normal',
  letterSpacing: 'normal',
  textTransform: 'none',
  zIndex: 2147483647,
};

/**
 * Re-arms the release guard on every menu open. Rendered inside the Radix
 * content subtree (mounted/unmounted with the menu), so its mount effect runs
 * once per open regardless of the outer wrapper's persistence.
 */
function ArmReleaseGuard({ armedRef }: { armedRef: React.MutableRefObject<boolean> }) {
  React.useLayoutEffect(() => {
    armedRef.current = true;
  }, [armedRef]);
  return null;
}

function ContextMenu({
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Root>) {
  return <ContextMenuPrimitive.Root data-slot='context-menu' {...props} />;
}

function ContextMenuTrigger({
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Trigger>) {
  return (
    <ContextMenuPrimitive.Trigger data-slot='context-menu-trigger' {...props} />
  );
}

function ContextMenuGroup({
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Group>) {
  return (
    <ContextMenuPrimitive.Group data-slot='context-menu-group' {...props} />
  );
}

function ContextMenuPortal({
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Portal>) {
  return (
    <ContextMenuPrimitive.Portal data-slot='context-menu-portal' {...props} />
  );
}

function ContextMenuSub({
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Sub>) {
  return <ContextMenuPrimitive.Sub data-slot='context-menu-sub' {...props} />;
}

function ContextMenuRadioGroup({
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.RadioGroup>) {
  return (
    <ContextMenuPrimitive.RadioGroup
      data-slot='context-menu-radio-group'
      {...props}
    />
  );
}

function ContextMenuSubTrigger({
  className,
  inset,
  children,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.SubTrigger> & {
  inset?: boolean
}) {
  return (
    <ContextMenuPrimitive.SubTrigger
      data-slot='context-menu-sub-trigger'
      data-inset={inset}
      className={cn(
        'focus:bg-accent focus:text-accent-foreground data-[state=open]:bg-accent data-[state=open]:text-accent-foreground [&_svg:not([class*=\'text-\'])]:text-muted-foreground flex cursor-default items-center rounded-sm px-2 py-1.5 text-xs outline-hidden select-none data-[inset]:pl-8 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*=\'size-\'])]:size-4',
        className
      )}
      {...props}
    >
      {children}
      <Icon name="chevronRight" className='size-3 ml-auto' />
    </ContextMenuPrimitive.SubTrigger>
  );
}

function ContextMenuSubContent({
  className,
  container,
  style,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.SubContent> & {
  container?: HTMLElement | null
}) {
  const content = (
    <ContextMenuPrimitive.SubContent
      data-slot='context-menu-sub-content'
      className={cn(
        'bg-popover text-popover-foreground data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 min-w-[8rem] origin-(--radix-context-menu-content-transform-origin) overflow-hidden rounded-lg p-1 shadow-lg',
        className
      )}
      style={container ? { ...PORTAL_MENU_STYLE, ...style } : style}
      {...props}
    />
  );

  if (container) {
    return (
      <ContextMenuPrimitive.Portal container={container}>
        {content}
      </ContextMenuPrimitive.Portal>
    );
  }

  return content;
}

function ContextMenuContent({
  className,
  container,
  children,
  style,
  onPointerDown,
  onPointerUp,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Content> & {
  container?: HTMLElement | null
}) {
  // When the menu opens near a screen edge, Radix repositions it so an item
  // lands under the cursor. Releasing the right-click then fires a pointerup on
  // that item (with no prior pointerdown), which Radix treats as a selection —
  // instantly closing the menu. We arm a guard on open and swallow that first
  // release; a fresh pointerdown (intentional press) disarms it.
  const armedRef = React.useRef(false);

  const disarm = React.useCallback(() => {
    armedRef.current = false;
  }, []);

  return (
    <ContextMenuPrimitive.Portal container={container ?? undefined}>
      <ContextMenuPrimitive.Content
        data-slot='context-menu-content'
        className={cn(
          'bg-popover text-popover-foreground data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 max-h-(--radix-context-menu-content-available-height) min-w-[8rem] origin-(--radix-context-menu-content-transform-origin) overflow-x-hidden overflow-y-auto rounded-lg p-1 shadow-md',
          className
        )}
        style={container ? { ...PORTAL_MENU_STYLE, ...style } : style}
        onPointerDown={(event) => {
          onPointerDown?.(event);
          disarm();
        }}
        onPointerUp={(event) => {
          onPointerUp?.(event);
          disarm();
        }}
        {...props}
      >
        <ContextMenuReleaseGuard.Provider value={armedRef}>
          <ArmReleaseGuard armedRef={armedRef} />
          {children}
        </ContextMenuReleaseGuard.Provider>
      </ContextMenuPrimitive.Content>
    </ContextMenuPrimitive.Portal>
  );
}

function ContextMenuItem({
  className,
  inset,
  variant = 'default',
  onPointerUp,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Item> & {
  inset?: boolean
  variant?: 'default' | 'destructive'
}) {
  const armedRef = React.useContext(ContextMenuReleaseGuard);

  return (
    <ContextMenuPrimitive.Item
      data-slot='context-menu-item'
      data-inset={inset}
      data-variant={variant}
      className={cn(
        'focus:bg-accent focus:text-accent-foreground data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-destructive/10 dark:data-[variant=destructive]:focus:bg-destructive/20 data-[variant=destructive]:focus:text-destructive data-[variant=destructive]:*:[svg]:!text-destructive [&_svg:not([class*=\'text-\'])]:text-muted-foreground relative flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-xs outline-hidden select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[disabled]:cursor-not-allowed data-[inset]:pl-8 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*=\'size-\'])]:size-4',
        className
      )}
      onPointerUp={(event) => {
        onPointerUp?.(event);
        // Swallow the pointerup that ends the opening right-click. preventDefault
        // stops Radix's onPointerUp from firing a synthetic click (selection).
        if (!event.defaultPrevented && armedRef?.current) {
          event.preventDefault();
          armedRef.current = false;
        }
      }}
      {...props}
    />
  );
}

function ContextMenuCheckboxItem({
  className,
  children,
  checked,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.CheckboxItem>) {
  return (
    <ContextMenuPrimitive.CheckboxItem
      data-slot='context-menu-checkbox-item'
      className={cn(
        'focus:bg-accent focus:text-accent-foreground relative flex cursor-default items-center gap-2 rounded-sm py-1.5 pr-2 pl-8 text-xs outline-hidden select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*=\'size-\'])]:size-4',
        className
      )}
      checked={checked}
      {...props}
    >
      <span className='pointer-events-none absolute left-2 flex size-3.5 items-center justify-center'>
        <ContextMenuPrimitive.ItemIndicator>
          <CheckIcon className='size-4' />
        </ContextMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </ContextMenuPrimitive.CheckboxItem>
  );
}

function ContextMenuRadioItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.RadioItem>) {
  return (
    <ContextMenuPrimitive.RadioItem
      data-slot='context-menu-radio-item'
      className={cn(
        'focus:bg-accent focus:text-accent-foreground relative flex cursor-default items-center gap-2 rounded-sm py-1.5 pr-2 pl-8 text-xs outline-hidden select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*=\'size-\'])]:size-4',
        className
      )}
      {...props}
    >
      <span className='pointer-events-none absolute left-2 flex size-3.5 items-center justify-center'>
        <ContextMenuPrimitive.ItemIndicator>
          <CircleIcon className='size-2 fill-current' />
        </ContextMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </ContextMenuPrimitive.RadioItem>
  );
}

function ContextMenuLabel({
  className,
  inset,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Label> & {
  inset?: boolean
}) {
  return (
    <ContextMenuPrimitive.Label
      data-slot='context-menu-label'
      data-inset={inset}
      className={cn(
        'text-foreground px-2 py-1.5 text-xs font-medium data-[inset]:pl-8',
        className
      )}
      {...props}
    />
  );
}

function ContextMenuSeparator({
  className,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Separator>) {
  return (
    <ContextMenuPrimitive.Separator
      data-slot='context-menu-separator'
      className={cn('bg-border -mx-1 my-1 h-px', className)}
      {...props}
    />
  );
}

function ContextMenuShortcut({
  className,
  ...props
}: React.ComponentProps<'span'>) {
  return (
    <span
      data-slot='context-menu-shortcut'
      className={cn(
        'text-muted-foreground ml-auto text-xs tracking-widest',
        className
      )}
      {...props}
    />
  );
}

export {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuCheckboxItem,
  ContextMenuRadioItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuGroup,
  ContextMenuPortal,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuRadioGroup,
}
