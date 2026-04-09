# Remove Google Chat Channel

1. Comment out `import './gchat.js'` in `src/channels/index.ts`
2. Remove `GCHAT_CREDENTIALS` from `.env`
3. `npm uninstall @chat-adapter/gchat`
4. Rebuild and restart
