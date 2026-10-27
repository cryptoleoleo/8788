// No credentials are logged, copied, exported, or returned to the application.
// The upstream CLI retains ownership of all authentication operations.
const id = process.env.BAW_ISOLATED_ID;
if (!/^w_[a-f0-9]{24}$/.test(id || '')) throw new Error('Invalid isolated wallet ID');
const native = await import(process.env.BAW_KEYTAR_MODULE);
const keytar = native.default || native;
const service = (name) => {
  if (name !== 'baw') throw new Error('Unexpected keychain service');
  return `baw-original-multi.${id}`;
};
export default Object.freeze({
  getPassword: (s, a) => keytar.getPassword(service(s), a),
  setPassword: (s, a, value) => keytar.setPassword(service(s), a, value),
  deletePassword: (s, a) => keytar.deletePassword(service(s), a),
});
