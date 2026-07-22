/**
 * Human-friendly present-tense labels for agent tool calls, shown as status
 * lines in the chat panel (e.g. "add_layout" -> "Adding layout").
 *
 * Falls back to a humanized version of the raw tool name for anything not
 * explicitly mapped, so new tools still render reasonably without a code change.
 */
const TOOL_LABELS: Record<string, string> = {
  list_pages: 'Reading pages',
  get_page: 'Reading page',
  create_page: 'Creating page',
  update_page: 'Updating page',
  delete_page: 'Deleting page',
  get_layers: 'Reading layers',
  add_layer: 'Adding element',
  update_layer_design: 'Styling element',
  update_layer_text: 'Editing text',
  delete_layer: 'Removing element',
  move_layer: 'Moving element',
  batch_operations: 'Editing layers',
  add_layout: 'Adding section',
  list_layouts: 'Browsing layouts',
  create_collection: 'Creating collection',
  bind_collection_layer: 'Binding collection',
  upload_asset: 'Uploading image',
  search_google_fonts: 'Searching fonts',
  add_font: 'Adding font',
  create_color_variable: 'Adding color',
  create_component: 'Creating component',
  add_animation: 'Adding animation',
  get_unpublished_changes: 'Checking changes',
  publish: 'Publishing',
};

export function toolCallLabel(name: string): string {
  if (TOOL_LABELS[name]) return TOOL_LABELS[name];
  const words = name.replace(/_/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
