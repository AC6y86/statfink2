# URL Redirects

This document tracks all URL redirects configured for peninsulafootball.com.

## Current Redirects

| Path | Destination | Type | Purpose |
|------|------------|------|---------|
| `/draft` | https://docs.google.com/spreadsheets/d/1KnT8u76sPBYVCU1KsbCar3ea2zoX82KGLzt-5PY3kio/edit?gid=0#gid=0 | 301 (Permanent) | Fantasy Football Draft Sheet |
| `/board` | https://script.google.com/macros/s/AKfycbwa1ro-cTgDPeNCSZa5rqUy5gMHJMp0aD5UCQcYJ4GLk_Ucpfypx90BeLsNbGbczKaCFA/exec?view=board | 301 (Permanent) | Draft Board View |

## How to Add New Redirects

To add a new redirect, edit the file `/home/joepaley/statfink2/server/app.js`:

1. Locate the redirect section (around line 159, after the health check endpoint)
2. Add your new redirect using this format:

```javascript
// Redirect /your-path to destination
app.get('/your-path', (req, res) => {
    res.redirect(301, 'https://destination-url.com');
});
```

### Redirect Types

- **301 (Permanent)**: Use when the redirect is permanent. Search engines will update their index.
- **302 (Temporary)**: Use `res.redirect('url')` without status code for temporary redirects.

### Best Practices

1. **Place redirects early**: Add redirects after the health check but before other routes
2. **Use descriptive comments**: Always comment what the redirect is for
3. **Test the redirect**: After adding, test with `curl -I http://peninsulafootball.com/your-path`
4. **Restart the server**: Run `pm2 restart statfink2` to apply changes

### Example: Adding a New Redirect

If you want to add a redirect from `/rules` to a Google Doc:

```javascript
// Redirect /rules to league rules document
app.get('/rules', (req, res) => {
    res.redirect(301, 'https://docs.google.com/document/d/YOUR_DOC_ID/edit');
});
```

### Testing Redirects

After adding a redirect and restarting the server:

```bash
# Test locally
curl -I http://localhost:8000/draft

# Test on production
curl -I http://peninsulafootball.com/draft
```

You should see a `Location:` header with your destination URL and a `301 Moved Permanently` status.

## Maintenance Notes

- All redirects are handled at the Express.js application level
- No nginx or Apache configuration needed
- Changes require a server restart with `pm2 restart statfink2`