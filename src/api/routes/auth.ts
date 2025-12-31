import { Router } from 'express';
import jwt from 'jsonwebtoken';

const router = Router();

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const JWT_SECRET = process.env.JWT_SECRET;

if (!ADMIN_PASSWORD) {
  throw new Error('Defina ADMIN_PASSWORD nas variaveis de ambiente');
}

if (!JWT_SECRET) {
  throw new Error('Defina JWT_SECRET nas variaveis de ambiente');
}
const JWT_SECRET_VALUE: string = JWT_SECRET;

router.post('/login', (req, res) => {
  const { password } = req.body ?? {};

  if (typeof password !== 'string' || !password.length) {
    return res.status(400).json({ error: 'Senha obrigatoria' });
  }

  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Credenciais invalidas' });
  }

  const token = jwt.sign({ sub: 'admin' }, JWT_SECRET_VALUE, { expiresIn: '7d' });
  return res.json({ token });
});

export default router;
