const express = require('express');
const { z } = require('zod');
const { validate } = require('../middleware/validate');
const { asyncHandler } = require('../middleware/error');
const authService = require('../services/auth');

const router = express.Router();

// bcrypt only uses the first 72 bytes of a password; reject longer ones instead of silently truncating.
const password = z
  .string()
  .min(8, 'must be at least 8 characters')
  .refine((p) => Buffer.byteLength(p, 'utf8') <= 72, 'must be at most 72 bytes');

const registerSchema = z.object({
  username: z
    .string()
    .trim()
    .min(3)
    .max(32)
    .regex(/^[A-Za-z0-9_.-]+$/, 'may only contain letters, digits, _ . -'),
  password,
});

// Login is deliberately loose: any rule mismatch is just a failed login, not a hint about the rules.
const loginSchema = z.object({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(1024),
});

router.post('/register', validate({ body: registerSchema }), asyncHandler(async (req, res) => {
  const user = await authService.register(req.body.username, req.body.password);
  res.status(201).json(user);
}));

router.post('/login', validate({ body: loginSchema }), asyncHandler(async (req, res) => {
  const result = await authService.login(req.body.username, req.body.password);
  res.status(200).json(result);
}));

module.exports = router;
// scripts/seed.js validates the admin account against the same rules as a normal sign-up.
module.exports.registerSchema = registerSchema;
