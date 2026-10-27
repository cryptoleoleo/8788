// Loaded only for a newly-created, isolated BAW identity. Never for the legacy wallet.
import { registerHooks } from 'node:module';
const id = process.env.BAW_ISOLATED_ID;
if (!/^w_[a-f0-9]{24}$/.test(id || '')) throw new Error('Invalid isolated wallet ID');
const shim = new URL('./profile-keytar.mjs', import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@github/keytar' && context.parentURL !== shim) {
      const actual = nextResolve(specifier, context);
      process.env.BAW_KEYTAR_MODULE = actual.url;
      return { url: shim, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
