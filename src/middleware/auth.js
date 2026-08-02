import { ApiError } from '../errors.js';
import { timingSafeEqualString } from '../services/crypto.js';

export function authenticateApiKey(config) {
  return (req, _res, next) => {
    const headerKey = req.get('X-API-Key');
    const authorization = req.get('Authorization');
    const bearerKey = authorization?.startsWith('Bearer ') ? authorization.slice(7) : null;
    const providedKey = headerKey || bearerKey;

    if (!providedKey || !timingSafeEqualString(providedKey, config.apiKey)) {
      return next(new ApiError(401, 'Unauthorized'));
    }

    return next();
  };
}
