/**
 * Thin fetch wrapper for the admin app. Every endpoint answers
 * { success, data, message|error } (except /health). A redirect to /login
 * (public host, session expired) sends the browser there.
 */

export class ApiError extends Error {
    constructor(message, status, body) {
        super(message);
        this.status = status;
        this.body = body;
    }
}

async function request(path, options = {}) {
    const response = await fetch(path, {
        credentials: 'same-origin',
        headers: { Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}) },
        ...options
    });

    if (response.redirected && /\/login/.test(response.url)) {
        location.href = '/login';
        throw new ApiError('Login required', 401);
    }
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
        if (response.status === 401 || response.status === 403) location.href = '/login';
        throw new ApiError(`${response.status} ${response.statusText || 'unexpected response'}`, response.status);
    }
    const body = await response.json();
    if (!response.ok) {
        throw new ApiError(body.message || body.error || `${response.status} ${response.statusText}`, response.status, body);
    }
    return body;
}

export const api = {
    get: path => request(path),
    post: (path, body = {}) => request(path, { method: 'POST', body: JSON.stringify(body) }),
    put: (path, body = {}) => request(path, { method: 'PUT', body: JSON.stringify(body) }),
    del: path => request(path, { method: 'DELETE' })
};

/** Unwrap { success, data } → data (or the whole body when there is no data key). */
export async function getData(path) {
    const body = await api.get(path);
    return body && body.data !== undefined ? body.data : body;
}
