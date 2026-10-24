export function shouldFetchDataSourceOnMount({fetchData = true, fetchOnce = false, control = {}, fetchOwnedByParent = false} = {}) {
    if (!fetchData || fetchOwnedByParent || control?.loading === true) return false;
    // A failed automatic request is terminal for this mount lifecycle. Explicit
    // refreshes and parameter changes request through the datasource input path.
    if (control?.error) return false;
    return !(fetchOnce && control?.loaded === true);
}
