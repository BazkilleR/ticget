const { HttpError } = require('./error');

// Usage: validate({ body: schema, params: schema, query: schema })
// Replaces each part of req with the parsed (coerced/trimmed) value so handlers only see clean data.
function validate(schemas) {
  return (req, res, next) => {
    for (const part of ['params', 'query', 'body']) {
      const schema = schemas[part];
      if (!schema) continue;

      const result = schema.safeParse(req[part]);
      if (!result.success) {
        const message = result.error.issues
          .map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message))
          .join('; ');
        return next(new HttpError(400, 'validation_error', message));
      }
      // req.query is a getter in Express 5; defineProperty works for both 4 and 5.
      Object.defineProperty(req, part, { value: result.data, writable: true, configurable: true });
    }
    return next();
  };
}

module.exports = { validate };
