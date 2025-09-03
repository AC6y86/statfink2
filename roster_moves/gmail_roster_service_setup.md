# Gmail Roster Move Service Setup

## Prerequisites

1. Enable Gmail API in Google Cloud Console
2. Create OAuth2 credentials
3. Download credentials.json file

## Installation

```bash
npm install googleapis @google-cloud/local-auth sqlite3
```

## Configuration

Place your `credentials.json` in the `roster_moves/` directory.

The service will:
- Monitor Gmail for new emails
- Parse emails for roster move patterns
- Match player names against the database
- Log potential roster moves to a file