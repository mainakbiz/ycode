import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ELEMENT_TEMPLATES } from '@/lib/mcp/utils';
import { ANIMATION_EASES, PRESET_CATALOG } from '@/lib/mcp/animation-presets';

function getAvailableTemplates() {
  return Object.entries(ELEMENT_TEMPLATES).map(([key, t]) => ({
    key,
    name: t.name,
    description: t.description,
  }));
}

const EXAMPLE_PROMPTS = {
  description: 'Example prompts and tool usage patterns for common YCode tasks',
  quick_start: {
    title: 'Build a complete landing page',
    prompt: 'Create a modern landing page with a hero section, 3 feature cards, testimonials, and a footer.',
    workflow: [
      '1. create_page with name and slug',
      '2. list_layouts to see available pre-built templates',
      '3. add_layout with key "hero-002" for a centered hero section',
      '4. add_layout with key "features-001" for a 3-column feature cards section',
      '5. add_layout with key "testimonials-002" for testimonial cards',
      '6. add_layout with key "footer-001" for a multi-column footer',
      '7. get_layers to verify the structure looks correct',
      '8. batch_operations to customize text content across all sections',
      '9. upload_asset + update_layer_image to set images',
      '10. batch_operations to refine design (colors, typography, spacing)',
      '11. publish to make it live',
    ],
  },
  critical_rules: [
    'ALWAYS use add_layout first — 48 pre-built templates cover most needs',
    'Only build from scratch when no template matches',
    'EVERY section MUST follow: section → container (maxWidth 1280px) → content',
    'NEVER put text/heading/image directly inside a section — wrap in container',
    'ALWAYS set isActive: true on design categories or properties won\'t apply',
    'ALWAYS set fontSize + fontWeight + lineHeight together for text',
    'After building, call get_layers to verify the structure is correct',
  ],
  tips: [
    'Use batch_operations whenever building more than 2-3 layers',
    'Create styles (create_style) before building repeating elements',
    'Use ref_id in batch_operations to reference layers created in the same batch',
    'Style a layer with an update_design operation referencing the ref_id from its add_layer',
    'Use add_font + search_google_fonts to add custom fonts before using them',
    'Always publish after completing changes',
    'For repeating UI primitives, build a component and use create_component_variant for visual flavors',
    'For tabular data, add_layer template "table" gives a ready-made structure to populate',
    'For tables inside rich text, use rich_content { type: "table", rows: [[...]], header_row: true }',
    'For dynamic pages, update_page is_dynamic + update_page_settings.cms is the canonical wiring path',
    'For lightbox galleries fed by a CMS image field, set lightbox.files_source "cms" + files_field_id',
  ],
};

// Reference resources are fully static — their content is derived from compile-time
// imports (ELEMENT_TEMPLATES, PRESET_CATALOG, ANIMATION_EASES) and inline constants.
// Stringify them once at module load so every resource read just hands back the
// cached string instead of re-serializing on every fetch.
const ELEMENTS_REFERENCE_JSON = JSON.stringify({
  templates: getAvailableTemplates(),
  nesting_rules: {
    cannot_have_children: [
      'icon', 'image', 'audio', 'video', 'iframe',
      'text', 'span', 'label', 'hr',
      'input', 'textarea', 'select', 'checkbox', 'radio',
      'htmlEmbed',
    ],
    section_cannot_contain_section: true,
    links_cannot_nest: true,
    component_instance_children_are_readonly: true,
    create_component_instances_with: ['add_component_instance', 'replace_layer_with_component'],
    customize_component_instance_with: 'set_component_instance',
    detach_component_instance_with: 'detach_component_instance',
    component_instances_note: 'A page layer with a componentId is a component instance. Its inner layers are read-only in place. To edit a component\'s structure/design, target the master with get_component + update_component_layers; per-instance content uses variables/overrides.',
  },
  element_types: {
    structure: {
      section: 'Full-width page section.',
      div: 'Generic container.',
      container: 'Max-width container (1280px) with padding.',
      columns: '2-column flexbox layout.',
      grid: '2x2 CSS Grid layout.',
      collection: 'CMS collection list (repeats children for each item).',
      hr: 'Horizontal divider line.',
      table: 'Data table (<table>). Ships with header + 2 body rows.',
      thead: '<thead> — add inside a table.',
      tbody: '<tbody> — add inside a table.',
      tr: '<tr> — add inside thead or tbody.',
      td: '<td> — add inside a tr.',
      th: '<th> — add inside a thead tr.',
    },
    content: {
      heading: 'Heading text (h1). 48px bold.',
      text: 'Paragraph text (p). 16px.',
      richText: 'Rich text block. Use set_rich_text_content or rich_content in add_layer.',
    },
    media: {
      image: 'Image element. Use update_layer_image to set asset.',
      video: 'Video player. Use update_layer_video to set source.',
      audio: 'Audio player.',
      icon: 'SVG icon. 24x24px.',
      iframe: 'Iframe embed. Use update_layer_iframe to set URL.',
    },
    interactive: {
      _note: 'ALWAYS build forms from these native elements. NEVER simulate fields with div, styled text, or htmlEmbed — only native fields are wired for submission, validation, and editing.',
      button: 'Button with text child. Use update_layer_link to set destination.',
      form: 'Native form. Pre-populated with name/email/message fields, a submit button, and success/error alerts. Configure submission via update_form_settings.',
      input: 'Native text input with a label wrapper. Set type/placeholder/name via update_layer_settings.',
      textarea: 'Native multi-line textarea with a label wrapper.',
      select: 'Native dropdown select input.',
      checkbox: 'Native checkbox input.',
      radio: 'Native radio button input.',
      filter: 'Collection filter input.',
      label: 'Form label element.',
    },
    utility: {
      htmlEmbed: 'Custom HTML/CSS/JS code. Set via update_layer_settings.',
      slider: 'Carousel with navigation, pagination, autoplay. Configure via update_layer_settings.',
      lightbox: 'Fullscreen gallery with thumbnails, navigation, zoom.',
      map: 'Interactive map element.',
      localeSelector: 'Language switcher for multi-language sites.',
    },
  },
});

const DESIGN_REFERENCE_JSON = JSON.stringify({
  instructions: 'Set isActive: true on any category for it to take effect. Use ui_state parameter for hover/focus/active styles. Use bgGradientVars for gradient backgrounds.',
  categories: {
    layout: {
      display: { type: 'enum', values: ['Flex', 'block', 'inline-block', 'grid', 'hidden'] },
      flexDirection: { type: 'enum', values: ['row', 'column', 'row-reverse', 'column-reverse'] },
      justifyContent: { type: 'enum', values: ['start', 'end', 'center', 'between', 'around', 'evenly'] },
      alignItems: { type: 'enum', values: ['start', 'end', 'center', 'baseline', 'stretch'] },
      alignSelf: { type: 'enum', values: ['auto', 'start', 'end', 'center', 'stretch', 'baseline'], description: 'Override parent alignItems for this child. Flex children stretch full-width by default — use start/center on badges and buttons in a flex column.' },
      gap: { type: 'css_value', examples: ['16px', '1rem'] },
      gridTemplateColumns: { type: 'string', examples: ['4', '1fr 1fr 1fr', 'repeat(3, 1fr)'], description: 'A bare integer is accepted and normalized to repeat(N, 1fr).' },
    },
    typography: {
      fontSize: { type: 'css_value', examples: ['16px', '48px'] },
      fontWeight: { type: 'string', examples: ['400', '600', '700'] },
      fontFamily: { type: 'string', examples: ['DM Sans', 'Plus Jakarta Sans'] },
      lineHeight: { type: 'css_value', examples: ['1.1', '1.5'] },
      letterSpacing: { type: 'css_value', examples: ['-0.03em', '0'] },
      textAlign: { type: 'enum', values: ['left', 'center', 'right'] },
      color: { type: 'color', examples: ['#171717', '#ffffff'] },
    },
    spacing: { padding: { type: 'css_value' }, margin: { type: 'css_value' } },
    sizing: {
      width: { type: 'css_value', examples: ['100%', 'auto'] },
      maxWidth: { type: 'css_value', examples: ['1280px'] },
      aspectRatio: { type: 'string', examples: ['16/9', '1/1'] },
    },
    borders: {
      borderRadius: { type: 'css_value', examples: ['12px', '9999px'] },
      borderWidth: { type: 'css_value' },
      borderColor: { type: 'color' },
    },
    backgrounds: {
      backgroundColor: { type: 'color', examples: ['#ffffff', '#0a0a0a'] },
      backgroundClip: { type: 'enum', values: ['text', 'border', 'padding'] },
      bgGradientVars: {
        type: 'record',
        description: 'CSS gradient values keyed by var name. "--bg-img" for desktop neutral.',
        examples: [{ '--bg-img': 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)' }],
      },
    },
    effects: {
      opacity: { type: 'string' },
      boxShadow: { type: 'string' },
    },
    positioning: {
      position: { type: 'enum', values: ['relative', 'absolute', 'fixed', 'sticky'] },
      zIndex: { type: 'string' },
    },
    transforms: {
      translateX: { type: 'css_value', examples: ['10px', '50%'] },
      translateY: { type: 'css_value', examples: ['10px', '50%'] },
      scale: { type: 'css_value', examples: ['1', '1.05', '0.95'] },
      rotate: { type: 'css_value', examples: ['0deg', '45deg', '-90deg'] },
      skewX: { type: 'css_value', examples: ['0deg', '10deg'] },
      skewY: { type: 'css_value', examples: ['0deg', '10deg'] },
      transformOrigin: { type: 'string', examples: ['center', 'top left'] },
    },
    transitions: {
      transitionProperty: { type: 'string', examples: ['all', 'colors', 'transform'] },
      transitionDuration: { type: 'css_value', examples: ['150ms', '300ms'] },
      transitionTimingFunction: { type: 'enum', values: ['linear', 'in', 'out', 'in-out'] },
      transitionDelay: { type: 'css_value', examples: ['0ms', '100ms'] },
    },
  },
});

const ANIMATION_PRESETS_REFERENCE_JSON = JSON.stringify({
  instructions: 'Use add_animation with a preset key for the common cases. Drop down to set_layer_interactions only when you need full GSAP control.',
  presets: PRESET_CATALOG,
  triggers: {
    click: 'Fires on user click. Use for affordances (pulse, shake). With timeline.yoyo: true, consecutive clicks alternate forward/reverse — i.e. a toggle (open then close). See toggle_pattern.',
    hover: 'Fires on mouseenter, reverses on mouseleave. Auto-yoyos so you only define the "to" state.',
    'scroll-into-view': 'Fires once when the element enters the viewport. Default for reveal presets.',
    'while-scrolling': 'Tween is scrubbed by scroll position. Set timeline.scrub. Use for parallax / progress effects.',
    load: 'Fires on page load. Use for loops or on-load entrance choreography.',
  },
  toggle_pattern: {
    description: 'Show/hide toggle for expandable menus (mobile nav), dropdowns, and accordions. No preset exists — use set_layer_interactions. Put a click interaction with timeline.yoyo: true on the trigger (e.g. hamburger button); its tween targets the panel layer (layer_id = the menu being shown/hidden, usually a sibling, NOT the button) and animates display "hidden" -> "visible". apply_styles.display: "on-load" makes the panel start collapsed. Scope to breakpoints ["mobile"] for hamburger menus; use all breakpoints for dropdowns/accordions. For an animated reveal, also tween autoAlpha "0"->"100" and/or height/y with apply_styles on-trigger.',
    see_also: 'add_layout("navigation-001" | "navigation-002") ships a working responsive mobile menu toggle to reuse.',
    example: {
      trigger: 'click',
      timeline: { breakpoints: ['mobile'], repeat: 0, yoyo: true },
      tweens: [{
        layer_id: 'lyr_menu_container (the element shown/hidden, not the button)',
        position: '>',
        duration: 0,
        ease: 'power1.out',
        from: { display: 'hidden' },
        to: { display: 'visible' },
        apply_styles: { display: 'on-load' },
      }],
    },
  },
  eases: ANIMATION_EASES,
  tween_value_formats: {
    'x | y | width | height': 'CSS length string with unit ("100px", "50%", "5rem").',
    scale: 'Unitless number string ("1", "1.05").',
    'rotation | skewX | skewY': 'Degrees with suffix ("45deg", "-90deg").',
    autoAlpha: 'Opacity 0-100 as plain string ("0", "100") — no % suffix.',
    backgroundColor: 'Hex or rgb() string ("#ffffff").',
    display: '"visible" or "hidden".',
  },
  tween_position: {
    number: 'Absolute time in seconds from timeline start.',
    '">"': 'Start after the previous tween ends.',
    '"<"': 'Start with the previous tween (overlap).',
  },
  apply_styles_modes: {
    'on-load': 'Apply the "from" value immediately on page load. Use for reveal animations to avoid FOUC.',
    'on-trigger': 'Apply the "from" value only when the trigger fires. Use for hover/click (element looks normal until interacted with).',
  },
  interaction_shape_example: {
    id: 'int_xxx (auto-generated if omitted)',
    trigger: 'scroll-into-view',
    timeline: {
      breakpoints: ['desktop', 'tablet', 'mobile'],
      repeat: 0,
      yoyo: false,
      toggleActions: 'play none none none',
    },
    tweens: [{
      id: 'twn_xxx (auto-generated if omitted)',
      layer_id: 'lyr_xxx',
      position: 0,
      duration: 0.6,
      ease: 'power1.out',
      from: { autoAlpha: '0', y: '40px' },
      to: { autoAlpha: '100', y: '0px' },
      apply_styles: { autoAlpha: 'on-load', y: 'on-load' },
    }],
  },
});

const PROMPTS_REFERENCE_JSON = JSON.stringify(EXAMPLE_PROMPTS);

export function registerReferenceResources(server: McpServer) {
  server.resource(
    'elements-reference',
    'ycode://reference/elements',
    {
      description: 'Available element types, nesting rules, and which elements can have children',
      mimeType: 'application/json',
    },
    async () => ({
      contents: [{
        uri: 'ycode://reference/elements',
        mimeType: 'application/json',
        text: ELEMENTS_REFERENCE_JSON,
      }],
    }),
  );

  server.resource(
    'design-reference',
    'ycode://reference/design-properties',
    {
      description: 'Complete reference of all design property categories and allowed values',
      mimeType: 'application/json',
    },
    async () => ({
      contents: [{
        uri: 'ycode://reference/design-properties',
        mimeType: 'application/json',
        text: DESIGN_REFERENCE_JSON,
      }],
    }),
  );

  server.resource(
    'animation-presets-reference',
    'ycode://reference/animation-presets',
    {
      description: 'Animation preset catalog: keys, default triggers/durations/eases, plus the raw LayerInteraction shape for set_layer_interactions',
      mimeType: 'application/json',
    },
    async () => ({
      contents: [{
        uri: 'ycode://reference/animation-presets',
        mimeType: 'application/json',
        text: ANIMATION_PRESETS_REFERENCE_JSON,
      }],
    }),
  );

  server.resource(
    'prompts-reference',
    'ycode://reference/prompts',
    {
      description: 'Example prompts and workflows for common website-building tasks',
      mimeType: 'application/json',
    },
    async () => ({
      contents: [{
        uri: 'ycode://reference/prompts',
        mimeType: 'application/json',
        text: PROMPTS_REFERENCE_JSON,
      }],
    }),
  );
}
