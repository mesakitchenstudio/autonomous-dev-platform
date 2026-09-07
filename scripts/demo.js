process.env.DEMO_MODE = process.env.DEMO_MODE || 'true';
process.env.APP_ROLE = process.env.APP_ROLE || 'combined';
process.env.OWNER_TOKEN_BOOTSTRAP = process.env.OWNER_TOKEN_BOOTSTRAP || 'adp-demo-owner-token';
process.env.SECURITY_PROFILE = process.env.SECURITY_PROFILE || 'DEVELOPMENT';
process.env.SECRET_MASTER_KEY = process.env.SECRET_MASTER_KEY || '00'.repeat(32);
await import('../src/server.js');
