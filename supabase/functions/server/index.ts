import { Hono } from "npm:hono";
import { cors } from "npm:hono/cors";
import { logger } from "npm:hono/logger";
import { createClient } from "jsr:@supabase/supabase-js@2.49.8";
import * as kv from "./kv_store.ts";

// Supabase encaminha as requisições para a função mantendo o nome dela
// no caminho interno (por exemplo, /server/register).
const app = new Hono().basePath("/server");

app.use("*", logger(console.log));

// Enable CORS for all routes and methods
app.use(
  "/*",
  cors({
    origin: "*",
    allowHeaders: ["Content-Type", "Authorization"],
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    exposeHeaders: ["Content-Length"],
    maxAge: 600,
  }),
);

// Health check endpoint
app.get("/make-server-b421fc39/health", (c) => {
  return c.json({ status: "ok" });
});

const adminClient = () =>
  createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

const normalizeUsername = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9._-]/g, "");

const usernameToEmail = (username: string) => `${username}@ritmo-coletivo.local`;

const getAuthenticatedUser = async (authorization?: string) => {
  const token = authorization?.replace(/^Bearer\s+/i, "");
  if (!token) return null;

  const { data, error } = await adminClient().auth.getUser(token);
  return error ? null : data.user;
};

app.post("/make-server-b421fc39/register", async (c) => {
  try {
    const body = await c.req.json();
    const name = String(body.name || "").trim();
    const username = normalizeUsername(String(body.username || ""));
    const password = String(body.password || "");
    const inviteCode = String(body.inviteCode || "");
    const officeInviteCode = Deno.env.get("OFFICE_INVITE_CODE");

    if (!officeInviteCode) {
      return c.json({ error: "O código do escritório ainda não foi configurado." }, 503);
    }
    if (inviteCode !== officeInviteCode) {
      return c.json({ error: "Código do escritório incorreto." }, 403);
    }
    if (name.length < 2) {
      return c.json({ error: "Informe seu nome completo." }, 400);
    }
    if (username.length < 3) {
      return c.json({ error: "O usuário deve ter pelo menos 3 caracteres." }, 400);
    }
    if (password.length < 6) {
      return c.json({ error: "A senha deve ter pelo menos 6 caracteres." }, 400);
    }

    const existingUsername = await kv.get(`username:${username}`);
    if (existingUsername) {
      return c.json({ error: "Este nome de usuário já está em uso." }, 409);
    }

    const { data, error } = await adminClient().auth.admin.createUser({
      email: usernameToEmail(username),
      password,
      email_confirm: true,
      user_metadata: { name, username },
    });

    if (error || !data.user) {
      console.log("Registration error:", error?.message);
      return c.json({ error: "Não foi possível criar o acesso." }, 400);
    }

    const profile = {
      id: data.user.id,
      name,
      username,
      createdAt: new Date().toISOString(),
    };
    await kv.mset([`username:${username}`, `profile:${data.user.id}`], [data.user.id, profile]);

    return c.json({ profile });
  } catch (error) {
    console.log("Registration failure:", error);
    return c.json({ error: "Erro inesperado ao criar o acesso." }, 500);
  }
});

app.post("/make-server-b421fc39/checkins", async (c) => {
  try {
    const user = await getAuthenticatedUser(c.req.header("Authorization"));
    if (!user) return c.json({ error: "Sessão inválida ou expirada." }, 401);

    const body = await c.req.json();
    const date = String(body.date || "");
    const minutes = Number(body.minutes);
    const distance = Number(body.distance);
    const feeling = String(body.feeling || "");
    const validFeelings = ["Leve", "Bom", "Puxado"];

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return c.json({ error: "Informe uma data válida." }, 400);
    }
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > 600) {
      return c.json({ error: "A duração deve estar entre 1 e 600 minutos." }, 400);
    }
    if (!Number.isFinite(distance) || distance < 0 || distance > 100) {
      return c.json({ error: "A distância deve estar entre 0 e 100 km." }, 400);
    }
    if (!validFeelings.includes(feeling)) {
      return c.json({ error: "Selecione como você se sentiu." }, 400);
    }

    const profile = await kv.get(`profile:${user.id}`);
    if (!profile) return c.json({ error: "Perfil não encontrado." }, 404);

    const checkin = {
      id: crypto.randomUUID(),
      userId: user.id,
      name: profile.name,
      username: profile.username,
      date,
      minutes: Math.round(minutes),
      distance: Math.round(distance * 100) / 100,
      feeling,
      createdAt: new Date().toISOString(),
    };

    await kv.set(`checkin:${date}:${checkin.id}`, checkin);
    return c.json({ checkin });
  } catch (error) {
    console.log("Check-in failure:", error);
    return c.json({ error: "Não foi possível registrar o treino." }, 500);
  }
});

app.get("/make-server-b421fc39/dashboard", async (c) => {
  try {
    const user = await getAuthenticatedUser(c.req.header("Authorization"));
    if (!user) return c.json({ error: "Sessão inválida ou expirada." }, 401);

    const profiles = await kv.getByPrefix("profile:");
    const checkins = await kv.getByPrefix("checkin:");
    const today = new Date();
    const day = today.getDay() || 7;
    const currentMonday = new Date(today);
    currentMonday.setHours(0, 0, 0, 0);
    currentMonday.setDate(today.getDate() - day + 1);

    const getWeekStart = (dateValue: string) => {
      const date = new Date(`${dateValue}T12:00:00`);
      const weekday = date.getDay() || 7;
      date.setDate(date.getDate() - weekday + 1);
      return date.toISOString().slice(0, 10);
    };

    const currentWeekKey = currentMonday.toISOString().slice(0, 10);
    const leaderboard = profiles
      .map((profile) => {
        const memberCheckins = checkins.filter((item) => item.userId === profile.id);
        const weekKeys = new Set(memberCheckins.map((item) => getWeekStart(item.date)));
        let streak = 0;
        const cursor = new Date(currentMonday);

        while (weekKeys.has(cursor.toISOString().slice(0, 10))) {
          streak += 1;
          cursor.setDate(cursor.getDate() - 7);
        }

        const thisWeek = memberCheckins.filter(
          (item) => getWeekStart(item.date) === currentWeekKey,
        );
        return {
          id: profile.id,
          name: profile.name,
          username: profile.username,
          weekCount: thisWeek.length,
          streak,
          totalCount: memberCheckins.length,
          totalMinutes: memberCheckins.reduce((sum, item) => sum + item.minutes, 0),
          totalDistance: Math.round(
            memberCheckins.reduce((sum, item) => sum + item.distance, 0) * 100,
          ) / 100,
        };
      })
      .sort(
        (a, b) =>
          b.weekCount - a.weekCount || b.streak - a.streak || b.totalCount - a.totalCount,
      );

    const recent = checkins
      .sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      )
      .slice(0, 20);

    return c.json({
      me: leaderboard.find((member) => member.id === user.id),
      leaderboard,
      recent,
      team: {
        members: profiles.length,
        weekCount: leaderboard.reduce((sum, member) => sum + member.weekCount, 0),
      },
    });
  } catch (error) {
    console.log("Dashboard failure:", error);
    return c.json({ error: "Não foi possível carregar o placar." }, 500);
  }
});

Deno.serve(app.fetch);
