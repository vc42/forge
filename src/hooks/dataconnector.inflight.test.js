import { describe, expect, it, vi, beforeEach } from 'vitest';

const {warn} = vi.hoisted(() => ({warn: vi.fn()}));

vi.mock('../core/index.js', () => ({
    useSetting: () => ({ endpoints: {}, useAuth: () => ({}), targetContext: {} }),
}));

vi.mock('../utils/logger.js', () => ({
    getLogger: () => ({
        debug: () => {},
        warn,
    }),
}));

import { createDataConnector } from './dataconnector.js';

describe('createDataConnector', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        warn.mockClear();
    });

    it('dedupes identical in-flight GET requests by exact request identity', async () => {
        let resolveFetch;
        global.fetch = vi.fn().mockImplementation(() => new Promise((resolve) => {
            resolveFetch = () => resolve({
                ok: true,
                status: 200,
                json: async () => ({ ok: true }),
            });
        }));

        const connector = createDataConnector({
            service: {
                URL: '/v1/workspace/metadata',
                method: 'GET',
            },
        }, { endpoints: {}, targetContext: {}, auth: {} });

        const first = connector.get({});
        const second = connector.get({});
        resolveFetch();

        await expect(first).resolves.toEqual({ ok: true });
        await expect(second).resolves.toEqual({ ok: true });
        expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it('applies caller-provided request preparation without hardcoding app context', async () => {
        global.fetch = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({ ok: true }),
        });

        const connector = createDataConnector({
            service: {
                URL: '/v1/api/datasources/account/fetch',
                method: 'POST',
            },
        }, {
            endpoints: {},
            targetContext: {},
            auth: {},
            prepareRequest: ({ queryParams, body }) => {
                queryParams.append('scope', 'conversation');
                if (body && typeof body === 'object') {
                    body.conversationId = 'conv-1';
                }
            },
        });

        await expect(connector.get({ filter: {}, inputParameters: {} })).resolves.toEqual({ ok: true });
        expect(global.fetch).toHaveBeenCalledWith(
            '/v1/api/datasources/account/fetch?scope=conversation',
            expect.objectContaining({
                method: 'POST',
                body: JSON.stringify({
                    inputs: {},
                    conversationId: 'conv-1',
                }),
            })
        );
    });

    it('appends target context for mutation methods when requested by the service', async () => {
        global.fetch = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({ ok: true }),
        });

        const connector = createDataConnector({
            service: {
                URL: '/v1/api/resource',
                includeTargetContext: true,
            },
        }, {
            endpoints: {},
            targetContext: {
                platform: 'android',
                formFactor: 'phone',
                surface: 'compose',
                capabilities: ['markdown', 'chart'],
            },
            auth: {},
        });

        await expect(connector.post({ body: { name: 'created' } })).resolves.toEqual({ ok: true });
        await expect(connector.patch({ body: { name: 'patched' } })).resolves.toEqual({ ok: true });
        await expect(connector.put({ body: { name: 'updated' } })).resolves.toEqual({ ok: true });
        await expect(connector.del({ id: 'item-1' })).resolves.toEqual({ ok: true });

        expect(global.fetch).toHaveBeenCalledTimes(4);
        for (const [url] of global.fetch.mock.calls) {
            const parsed = new URL(url, 'https://forge.test');
            expect(parsed.searchParams.get('platform')).toBe('android');
            expect(parsed.searchParams.get('formFactor')).toBe('phone');
            expect(parsed.searchParams.get('surface')).toBe('compose');
            expect(parsed.searchParams.getAll('capabilities')).toEqual(['markdown', 'chart']);
        }
    });

    it('preserves existing metadata query parameters when appending the web target', async () => {
        global.fetch = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({ ok: true }),
        });
        const reference = JSON.stringify({ uri: 'window://workspace/adOrderPicker' });
        const url = `/v1/api/agently/forge/window/adOrderPicker?resourceRef=${encodeURIComponent(reference)}&providerIdentity=internal`;
        const connector = createDataConnector({ service: { URL: url, includeTargetContext: true } }, {
            endpoints: {}, auth: {},
            targetContext: { platform: 'web', formFactor: 'desktop', surface: 'browser', capabilities: ['markdown'] },
        });

        await expect(connector.get({})).resolves.toEqual({ ok: true });
        const requested = new URL(global.fetch.mock.calls[0][0], 'https://forge.test');
        expect(JSON.parse(requested.searchParams.get('resourceRef'))).toEqual({ uri: 'window://workspace/adOrderPicker' });
        expect(requested.searchParams.get('providerIdentity')).toBe('internal');
        expect(requested.searchParams.get('platform')).toBe('web');
        expect(requested.searchParams.get('formFactor')).toBe('desktop');
        expect(requested.searchParams.get('surface')).toBe('browser');
        expect(requested.searchParams.getAll('capabilities')).toEqual(['markdown']);
    });

    it('does not treat an upstream datasource 401 as an expired workspace session', async () => {
        const handleUnauthorized = vi.fn();
        const response = {
            ok: false,
            status: 401,
            statusText: 'Unauthorized',
            headers: { get: () => null },
            clone() { return this; },
            text: async () => 'upstream MCP authorization failed',
        };
        global.fetch = vi.fn().mockResolvedValue(response);
        const connector = createDataConnector({
            service: { URL: '/v1/api/datasources/advertiser/fetch', method: 'POST' },
        }, { endpoints: {}, targetContext: {}, auth: { handleUnauthorized } });

        await expect(connector.get({ filter: {}, inputParameters: {} })).rejects.toThrow('upstream MCP authorization failed');
        expect(handleUnauthorized).not.toHaveBeenCalled();
    });

    it('requests login when Agently explicitly marks a workspace authentication failure', async () => {
        const handleUnauthorized = vi.fn();
        const response = {
            ok: false,
            status: 401,
            statusText: 'Unauthorized',
            headers: { get: (name) => name === 'X-Agently-Auth-Required' ? 'true' : null },
            clone() { return this; },
            text: async () => 'authorization required',
        };
        global.fetch = vi.fn().mockResolvedValue(response);
        const connector = createDataConnector({
            service: { URL: '/v1/api/datasources/advertiser/fetch', method: 'POST' },
        }, { endpoints: {}, targetContext: {}, auth: { handleUnauthorized } });

        await expect(connector.get({ filter: {}, inputParameters: {} })).rejects.toThrow('authorization required');
        expect(handleUnauthorized).toHaveBeenCalledOnce();
    });

    it.each([false, true])('diagnoses a 401 safely with host auth marker=%s', async authRequired => {
        const handleUnauthorized = vi.fn();
        const response = {
            ok: false, status: 401, statusText: 'Unauthorized',
            url: 'https://private-user:private-password@host.test:8100/v1/api/agently/forge/window/advertiser?token=query-secret#fragment-secret',
            headers: {get: name => name === 'X-Agently-Auth-Required' && authRequired ? 'true' : null},
            clone() { return this; },
            text: async () => JSON.stringify({code: 'authorization_required', error: 'private-response-body'}),
        };
        global.fetch = vi.fn().mockResolvedValue(response);
        const connector = createDataConnector({service: {URL: '/v1/api/agently/forge/window/advertiser'}}, {
            auth: {handleUnauthorized},
        });
        await expect(connector.get({})).rejects.toMatchObject({status: 401, authRequired, code: 'authorization_required'});
        expect(warn).toHaveBeenCalledExactlyOnceWith('request failed', JSON.stringify({
            url: 'https://host.test:8100/v1/api/agently/forge/window/advertiser',
            status: 401, authRequired, code: 'authorization_required',
        }));
        const diagnostic = JSON.stringify(warn.mock.calls);
        for (const secret of ['private-user', 'private-password', 'query-secret', 'fragment-secret', 'private-response-body']) {
            expect(diagnostic).not.toContain(secret);
        }
        expect(handleUnauthorized).toHaveBeenCalledTimes(authRequired ? 1 : 0);
    });
});

it('preserves the server dataset denial code/scope and leaves it recoverable',async()=>{
 global.fetch=vi.fn(async()=>new Response(JSON.stringify({error:'Datasource access denied. Adjust the filter or retry.',code:'datasource_denied',scope:'dataset'}),{status:403,statusText:'Forbidden',headers:{'Content-Type':'application/json'}}));
 const connector=createDataConnector({service:{URL:'/v1/api/datasources/rows/fetch'}});
 await expect(connector.get({})).rejects.toMatchObject({status:403,code:'datasource_denied',scope:'dataset',isUnauthorized:false});
});
it('does not turn an untyped403 or401 into a dataset marker',async()=>{
 global.fetch=vi.fn(async()=>new Response(JSON.stringify({error:'denied'}),{status:403,statusText:'Forbidden'}));
 const connector=createDataConnector({service:{URL:'/v1/api/datasources/rows/fetch'}});
 await expect(connector.get({})).rejects.toMatchObject({status:403,isUnauthorized:true});
});
it('explicit fresh metadata reads bypass pending GET sharing and browser response caches',async()=>{
 const completions=[];global.fetch=vi.fn(()=>new Promise(resolve=>completions.push(()=>resolve({ok:true,json:async()=>({fresh:true})}))));
 const connector=createDataConnector({service:{URL:'/v1/workspace/metadata',method:'GET'}},{endpoints:{},targetContext:{},auth:{}});
 const normal=connector.get({}),fresh=connector.get({fresh:true});expect(global.fetch).toHaveBeenCalledTimes(2);expect(global.fetch.mock.calls[0][1]).not.toHaveProperty('cache');expect(global.fetch.mock.calls[1][1].cache).toBe('no-store');for(const complete of completions)complete();await normal;await fresh;
});

describe('datasource read overlap', () => {
    const runtime = () => ({auth: {}, targetContext: {actorRef: 'user-a'}});
    const datasource = (id = 'audience_lookup') => ({
        id,
        service: {URL: `/v1/api/datasources/${id}/fetch`, method: 'POST'},
        paging: {enabled: true, size: 20, parameters: {page: 'Page', size: 'Limit'}},
    });
    function pendingFetch() {
        const releases = [];
        const response = {rows: [{id: 1}], dataInfo: {totalCount: 20}};
        vi.stubGlobal('fetch', vi.fn(() => new Promise(resolve => {
            releases.push(() => resolve({ok: true, status: 200, json: async () => response}));
        })));
        return () => releases.splice(0).forEach(release => release());
    }

    it('shares an identical datasource POST read across connectors in one runtime', async () => {
        const release = pendingFetch();
        const scope = runtime();
        const first = createDataConnector(datasource(), scope).get({page: 1});
        const second = createDataConnector(datasource(), scope).get({page: 1});
        const calls = fetch.mock.calls.length;
        release();
        const [a, b] = await Promise.all([first, second]);
        expect(calls).toBe(1);
        expect(a).toEqual(b);
        expect(a).not.toBe(b);
        a.rows[0].id = 99;
        expect(b.rows[0].id).toBe(1);
    });

    it.each(['filter', 'page', 'projection', 'cache', 'invocation'])('keeps different %s requests separate', async difference => {
        const release = pendingFetch();
        const connector = createDataConnector(datasource(), runtime());
        const changed = {
            filter: {filter: {AdOrderId: [42]}},
            page: {page: 2},
            projection: {inputParameters: {Fields: ['audienceId']}},
            cache: {cache: {bypassCache: true}},
            invocation: {invocationId: 'another-call'},
        }[difference];
        const first = connector.get({page: 1});
        const second = connector.get({page: 1, ...changed});
        const calls = fetch.mock.calls.length;
        release(); await Promise.all([first, second]);
        expect(calls).toBe(2);
    });

    it('separates runtime authorization scopes even with cookie authentication', async () => {
        const release = pendingFetch();
        const first = createDataConnector(datasource(), runtime()).get({page: 1});
        const second = createDataConnector(datasource(), runtime()).get({page: 1});
        const calls = fetch.mock.calls.length;
        release(); await Promise.all([first, second]); expect(calls).toBe(2);
    });

    it('separates prepared bearer credentials and provider identities', async () => {
        const release = pendingFetch();
        const scope = runtime();
        let user = 'user-a';
        scope.prepareRequest = ({headers, body}) => {
            headers.Authorization = `Bearer ${user}`;
            body.providerIdentity = user;
        };
        const connector = createDataConnector(datasource(), scope);
        const first = connector.get({}); user = 'user-b';
        const second = connector.get({});
        const calls = fetch.mock.calls.length;
        release(); await Promise.all([first, second]); expect(calls).toBe(2);
    });

    it('does not share independently cancellable reads or mutation POSTs', async () => {
        const release = pendingFetch();
        const connector = createDataConnector(datasource(), runtime());
        const signal = new AbortController().signal;
        const reads = [connector.get({signal}), connector.get({signal})];
        const writes = [connector.post({body: {id: 1}}), connector.post({body: {id: 1}})];
        const calls = fetch.mock.calls.length;
        release(); await Promise.all([...reads, ...writes]); expect(calls).toBe(4);
    });

    it('starts a fresh request after completion and after a shared failure', async () => {
        let attempt = 0;
        vi.stubGlobal('fetch', vi.fn(async () => {
            if (++attempt === 1) throw new Error('backend unavailable');
            return {ok: true, status: 200, json: async () => ({rows: []})};
        }));
        const connector = createDataConnector(datasource(), runtime());
        const results = await Promise.allSettled([connector.get({}), connector.get({})]);
        expect(results.every(result => result.status === 'rejected')).toBe(true);
        await connector.get({});
        await connector.get({});
        expect(fetch).toHaveBeenCalledTimes(3);
    });
});


describe('datasource read sharing boundaries', () => {
    function responseGate() {
        const resolvers = [];
        vi.stubGlobal('fetch', vi.fn(() => new Promise(resolve => resolvers.push(resolve))));
        return () => resolvers.forEach(resolve => resolve({ok: true, status: 200, json: async () => ({rows: []})}));
    }
    const ds = {id: 'lookup', service: {URL: '/v1/api/datasources/lookup/fetch', method: 'POST'}};

    it('normalizes object key order while preserving argument values', async () => {
        const release = responseGate();
        const connector = createDataConnector(ds, {});
        const first = connector.get({filter: {Name: 'A', Id: [2, 1]}});
        const second = connector.get({filter: {Id: [2, 1], Name: 'A'}});
        const calls = fetch.mock.calls.length;
        release(); await Promise.all([first, second]); expect(calls).toBe(1);
    });

    it('keeps different serialized Date arguments separate', async () => {
        const release = responseGate();
        const connector = createDataConnector(ds, {});
        const first = connector.get({inputParameters: {From: new Date('2026-10-22T00:00:00Z')}});
        const second = connector.get({inputParameters: {From: new Date('2026-10-23T00:00:00Z')}});
        const calls = fetch.mock.calls.length;
        release(); await Promise.all([first, second]);
        expect(calls).toBe(2);
    });

    it('shares arguments that serialize to the same wire body', async () => {
        const release = responseGate();
        const connector = createDataConnector(ds, {});
        const first = connector.get({inputParameters: {From: new Date('2026-10-22T00:00:00Z')}});
        const second = connector.get({inputParameters: {From: '2026-10-22T00:00:00.000Z'}});
        const calls = fetch.mock.calls.length;
        release(); await Promise.all([first, second]);
        expect(calls).toBe(1);
    });

    it.each(['credential', 'provider', 'conversation', 'resource', 'actor'])('does not share after a prepared %s change', async changed => {
        const release = responseGate();
        let value = 'first';
        const scope = {targetContext: {actorRef: 'actor-a'}, prepareRequest: ({headers, body}) => {
            if (changed === 'credential') headers.Authorization = `Bearer ${value}`;
            if (changed === 'provider') body.providerIdentity = value;
            if (changed === 'conversation') body.conversationId = value;
            if (changed === 'resource') body.reference = {owner: {uri: 'forge://workspace', revision: value}};
        }};
        const connector = createDataConnector(ds, scope);
        const first = connector.get({});
        value = 'second'; if (changed === 'actor') scope.targetContext.actorRef = 'actor-b';
        const second = connector.get({});
        const calls = fetch.mock.calls.length;
        release(); await Promise.all([first, second]); expect(calls).toBe(2);
    });

    it.each(['uncached', 'other-post', 'other-datasource'])('does not combine %s operations', async kind => {
        const release = responseGate();
        const scope = {};
        const config = kind === 'uncached' ? {...ds, cache: {enabled: false}}
            : kind === 'other-post' ? {...ds, service: {URL: '/v1/api/command', method: 'POST'}} : ds;
        const first = createDataConnector(config, scope).get({});
        const other = kind === 'other-datasource' ? {...ds, id: 'other', service: {...ds.service, URL: '/v1/api/datasources/other/fetch'}} : config;
        const second = createDataConnector(other, scope).get({});
        const calls = fetch.mock.calls.length;
        release(); await Promise.all([first, second]); expect(calls).toBe(2);
    });
});
