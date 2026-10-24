import {shouldFetchDialogOnOpen} from './viewDialogFreshState.js';

// A picker bundle retains the authored Dialog and uses the ordinary dialog
// lifecycle. The outer window transports its result back to the original caller.
export async function openWindowPickerDialog(window, metadata, context) {
    const id = window?.pickerDialogId;
    if (!id) return;
    if (!metadata?.dialogs?.some(dialog => dialog?.id === id)) throw new Error('Picker dialog is missing from its owning window bundle');
    const handlers = context?.handlers?.window;
    if (!handlers?.openDialog) throw new Error('Picker dialog handler is unavailable');
    const result = await handlers.openDialog({
        execution: {args: [id, {awaitResult: true, parameters: window.pickerParameters || [], cacheOnOpen: true}]},
        parameters: window.parameters || {}, context,
    });
    if (result?.status === 'canceled' || result?.status === 'busy' || !result) handlers.closeWindow?.();
    else handlers.commit?.({payload: result, context});
}

// A picker dialog owns its seeded read. The enclosing window must not prime
// the same datasource before the dialog has applied its inputs.
export function pickerDialogReadOwner(window = {}, metadata = {}, defaultRef = '') {
    const dialog = metadata?.dialogs?.find(entry => entry?.id === window?.pickerDialogId);
    if (!dialog || !shouldFetchDialogOnOpen(dialog)) return '';
    const ref = dialog.dataSourceRef || defaultRef;
    return metadata?.dataSource?.[ref] ? ref : '';
}
