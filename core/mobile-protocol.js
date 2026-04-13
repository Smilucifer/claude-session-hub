const CLIENT_TYPES = {
  subscribe: ['sessionId'],
  unsubscribe: ['sessionId'],
  input: ['sessionId', 'data'],
  'mark-read': ['sessionId'],
  ping: [],
};

function encode(msg) {
  return JSON.stringify(msg);
}

function decode(str) {
  try { return JSON.parse(str); } catch { return null; }
}

function validate(msg) {
  if (!msg || typeof msg !== 'object') return false;
  const required = CLIENT_TYPES[msg.type];
  if (!required) return false;
  for (const k of required) {
    if (!(k in msg)) return false;
  }
  return true;
}

module.exports = { encode, decode, validate, CLIENT_TYPES };
