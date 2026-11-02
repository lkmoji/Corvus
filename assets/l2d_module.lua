-- Corvus: Live2D-ассистент (модуль). Лежит в moonloader/resource/live2d_girl/l2d_module.lua, скачивается скриптом с GitHub.
-- Файл возвращает фабрику: return function(env) ... return M end.
-- env: OPT (настройки), imgui, DIR (папка с файлами), fetch(names, force, done) (скачивание файлов), u8 (кодировщик).
-- Файлы данных: data.lua + atlas_s.png (запасной вариант - atlas.png) рядом с этим модулем.
-- Файл в UTF-8; строки для чата декодируются в cp1251 в say().
return function(env)
    local OPT, imgui, DIR, fetch, u8 = env.OPT, env.imgui, env.DIR, env.fetch, env.u8
    local M = { state = 'init', W = 972, H = 1619 }
    local floor, ceil, sin, cos, abs, min, max, exp, random =
          math.floor, math.ceil, math.sin, math.cos, math.abs, math.min, math.max, math.exp, math.random

    local CFG = { track = true, head = 0.55, eyes = 1.0, hair = 1.0, hairSp = 1.0, body = 1.0,
                  blink = true, breath = true, idle = true,
                  fps = 40 }                                  -- частота ГЕНЕРАЦИИ (физика + сетка); отрисовка идёт каждый кадр из кэша
    local D, texAtlas
    local PP = {}                                          -- ImVec2 для экранных координат (общий буфер на самый большой слой)
    local C = {}                                           -- кэш по слоям: статика сетки + деформированные позиции
    local ACC, SINCE, LAST_OK = 0, 0, false                -- таймеры генерации

    local function clamp(x, a, b) if x < a then return a elseif x > b then return b end return x end
    local function smooth(t) if t <= 0 then return 0 elseif t >= 1 then return 1 end return t * t * (3 - 2 * t) end
    local function tanh(x) x = clamp(x, -10, 10); local e = exp(2 * x); return (e - 1) / (e + 1) end
    local function rgba(r, g, b, a) return floor(a) * 16777216 + floor(b) * 65536 + floor(g) * 256 + floor(r) end

    local function spring(s, target, w, z, dt)
        local n = ceil(dt / 0.006); local h = dt / n
        for _ = 1, n do
            local a = w * w * (target - s.x) - 2 * z * w * s.v
            s.v = s.v + a * h; s.x = s.x + s.v * h
        end
    end
    local function Sp(x) return { x = x or 0, v = 0 } end

    -- ---------------------------------------------------------------- simulation --
    local T = 0
    local st = {
        gx = Sp(), gy = Sp(),
        hx = Sp(), hy = Sp(), hz = Sp(),
        bx = Sp(), by = Sp(),
        arm = Sp(), hand = Sp(),
        hlx = Sp(), hly = Sp(), hrx = Sp(), hry = Sp(),
        slx = Sp(), sly = Sp(), srx = Sp(), sry = Sp(),
        lo1x = Sp(), lo2x = Sp(), lo1y = Sp(), lo2y = Sp(),
        wind = 0, wph = 0, wdir = 0, typeK = 0,
        wander = { tx = 0, ty = 0, t = 0 }, jit = { x = 0, y = 0, t = 0 },
        blinkT = 3, blinkPhase = nil, blinkQueue = 0,
        lastMouse = { x = -1, y = -1 }, still = 0, lidL = 0, lidR = 0,
    }

    local function updateBlink(dt, lookDown)
        local b, v = st, 0
        if CFG.blink then
            if b.blinkPhase == nil then
                b.blinkT = b.blinkT - dt
                if b.blinkT <= 0 then b.blinkPhase = 0 end
            end
            if b.blinkPhase then
                b.blinkPhase = b.blinkPhase + dt
                local c, h, o, p = 0.075, 0.035, 0.17, b.blinkPhase
                if p < c then v = (p / c) ^ 2
                elseif p < c + h then v = 1
                elseif p < c + h + o then local q = (p - c - h) / o; v = 1 - (1 - (1 - q) * (1 - q))
                else
                    b.blinkPhase = nil
                    if b.blinkQueue > 0 then b.blinkQueue = b.blinkQueue - 1; b.blinkT = 0.07
                    else b.blinkT = 2.2 + random() * 3.8; if random() < 0.22 then b.blinkQueue = 1 end end
                end
            end
        end
        local base = 0.14 * max(0, lookDown)
        b.lidL = max(base, v * (1 - base) + base)
        b.lidR = max(base, clamp(v * 1.04, 0, 1) * (1 - base) + base)
    end

    local function gazeAxis(d, c, size)
        local room = (d >= 0) and (size - c) or c
        local range = clamp(room * 0.85, 140, 0.2 * size)
        local t = clamp(d / range, -1, 1)
        local e = 1 - (1 - abs(t)) * (1 - abs(t))
        return (t >= 0) and e or -e
    end

    local function simulate(dt, mouseX, mouseY, cx, cy, sw, sh, haveMouse, typing)
        T = T + dt
        local tx, ty = 0, 0
        if haveMouse then
            if abs(mouseX - st.lastMouse.x) > 0.5 or abs(mouseY - st.lastMouse.y) > 0.5 then
                st.still = 0; st.lastMouse.x, st.lastMouse.y = mouseX, mouseY
            else st.still = st.still + dt end
        end
        if CFG.track and haveMouse and not (CFG.idle and st.still > 9) then
            tx = gazeAxis(mouseX - cx, cx, sw); ty = gazeAxis(mouseY - cy, cy, sh)
        else
            local w = st.wander
            w.t = w.t - dt
            if w.t <= 0 then
                w.t = 0.9 + random() * 2.8
                if random() < 0.35 then w.tx, w.ty = 0, 0
                else w.tx = (random() * 2 - 1) * 0.7; w.ty = (random() * 2 - 1) * 0.4 end
            end
            tx, ty = w.tx, w.ty
        end
        local j = st.jit
        j.t = j.t - dt
        if j.t <= 0 then j.t = 0.25 + random() * 0.9; j.x = (random() * 2 - 1) * 0.035; j.y = (random() * 2 - 1) * 0.03 end
        tx, ty = clamp(tx + j.x, -1, 1), clamp(ty + j.y, -1, 1)
        -- пока ассистент печатает: смотрит на панель сообщения (вправо-вниз)
        st.typeK = st.typeK + ((typing and 1 or 0) - st.typeK) * (1 - exp(-dt / 0.3))
        if st.typeK > 0.001 then
            local k = st.typeK * 0.6
            tx = tx + (0.5 - tx) * k; ty = ty + (0.35 - ty) * k
        end

        local REACT = 1.3
        local hf, bf = CFG.head * REACT, CFG.body * REACT
        local idleX, idleY, idleZ = sin(T * 0.43) * 0.06, sin(T * 0.37 + 1.0) * 0.05, sin(T * 0.29 + 2.0) * 0.025
        local htx, hty = tx * hf + idleX, ty * hf * 0.85 + idleY
        spring(st.gx, tx, 26, 0.92, dt);  spring(st.gy, ty, 26, 0.92, dt)
        spring(st.hx, htx, 7.5, 0.82, dt); spring(st.hy, hty, 7.5, 0.82, dt)
        spring(st.hz, -htx * 0.28 + idleZ, 6.5, 0.8, dt)
        spring(st.bx, (htx * 0.9 + sin(T * 0.52) * 0.30 + sin(T * 0.21 + 1.3) * 0.18) * bf * 0.9, 3.2, 0.7, dt)
        spring(st.by, (hty * 0.8 + sin(T * 0.47 + 0.6) * 0.25) * bf, 3.0, 0.7, dt)
        spring(st.arm, st.bx.x, 4.4, 0.34, dt)
        spring(st.hand, st.bx.x, 5.2, 0.22, dt)
        spring(st.hlx, st.hx.x + st.bx.x * 0.5, 3.4, 0.85, dt); spring(st.hrx, st.hx.x + st.bx.x * 0.5, 3.0, 0.9, dt)
        spring(st.hly, st.hy.x + st.by.x * 0.5, 3.6, 0.85, dt); spring(st.hry, st.hy.x + st.by.x * 0.5, 3.3, 0.9, dt)
        spring(st.slx, st.hx.x * 0.8 + st.bx.x * 0.7, 2.6, 0.9, dt); spring(st.srx, st.hx.x * 0.8 + st.bx.x * 0.7, 2.3, 0.95, dt)
        spring(st.sly, st.hy.x * 0.8 + st.by.x * 0.6, 2.7, 0.9, dt); spring(st.sry, st.hy.x * 0.8 + st.by.x * 0.6, 2.4, 0.95, dt)
        local lt, lty = st.bx.x + st.hx.x * 0.25, st.by.x + st.hy.x * 0.2
        spring(st.lo1x, lt, 3.0, 0.8, dt);  spring(st.lo2x, st.lo1x.x, 3.6, 0.7, dt)
        spring(st.lo1y, lty, 3.0, 0.8, dt); spring(st.lo2y, st.lo1y.x, 3.6, 0.7, dt)
        local sp = abs(st.hx.v) + abs(st.hy.v) * 0.8 + abs(st.bx.v) * 0.6
        local wt = clamp(sp * 1.6, 0, 1)
        local k = (wt > st.wind) and 0.35 or 1.8
        st.wind = st.wind + (wt - st.wind) * (1 - exp(-dt / k))
        st.wph = st.wph + dt * CFG.hairSp * (1 + 0.7 * st.wind)
        st.wdir = st.wdir + ((st.hx.v >= 0 and 1 or -1) * wt - st.wdir) * (1 - exp(-dt / 0.9))
        updateBlink(dt, st.gy.x - 0.5 * st.hy.x)
    end

    -- ---------------------------------------------------------- per-frame state --
    local FS = {}
    local HIP_Y, PIV_X, PIV_Y = 1330, 500, 565

    local function leanAt(x, y)
        local wl = 1
        if y > 1150 then wl = 1 - (y - 1150) / 300; if wl <= 0 then return 0, 0 end end
        local qx, qy = x - 500, y - HIP_Y
        return ((qx * FS.cp - qy * FS.sp) - qx) * wl, ((qx * FS.sp + qy * FS.cp) - qy) * wl
    end

    local function breathAt(x, y, k)
        if FS.breath == 0 then return 0, 0 end
        local gx, gy = (x - 500) / 230, (y - 760) / 230
        local bm = exp(-(gx * gx + gy * gy)) * k
        return (x - 500) * FS.breath * bm * 0.0035, -FS.breath * bm * 2.6
    end

    local function headAt(x, y, w, depth)
        if w <= 0.001 then return 0, 0 end
        local a = FS.hz * w
        local qx, qy = x - FS.pivx, y - FS.pivy
        return -qy * a + FS.hx * depth * w * 10, qx * a + FS.hy * depth * w * 6.5 - FS.breath * 0.9 * w
    end

    local function swayAt(x, y, root, len, amp, ph, lx, ly, cap, fm, lg)
        local r = smooth((y - root) / len)
        if r <= 0.001 then return 0, 0 end
        local p = FS.ph * fm
        local w = sin(p * 1.7 + ph + y * 0.013 + x * 0.006) * 0.55
                + sin(p * 2.9 + ph * 1.3 + y * 0.021 - x * 0.010) * 0.22
                + sin(p * 0.75 + ph * 0.7 + x * 0.004) * 0.85
        local wy = sin(p * 1.3 + ph + x * 0.020 + y * 0.010) * 0.5
        r = r * amp * FS.hairAmp
        local dx, dy = r * (w * 10 * FS.gust + lx * lg), r * (wy * 3.5 * FS.gust + ly * lg * 0.4 - FS.breath * 1.4)
        cap = cap or 16
        return cap * tanh(dx / cap), cap * 0.5 * tanh(dy / (cap * 0.5))
    end

    local function rotAbout(x, y, px, py, a, wgt)
        local qx, qy = x - px, y - py
        return (-qy * a) * wgt, (qx * a) * wgt
    end

    local function frameState()
        local ph = st.bx.x * 0.042 + 0
        FS.phi = ph; FS.cp, FS.sp = cos(ph), sin(ph)
        FS.hx, FS.hy, FS.hz = st.hx.x, st.hy.x, st.hz.x - ph * 0.6
        local lx, ly = leanAt(PIV_X, PIV_Y)
        FS.pivx, FS.pivy = PIV_X + lx, PIV_Y + ly + st.by.x * 5
        FS.breath = CFG.breath and (0.5 + 0.5 * sin(T * 1.9)) or 0
        FS.hairAmp, FS.ph = CFG.hair, st.wph
        FS.gust = (0.65 + 0.35 * sin(T * 0.37 * CFG.hairSp) * sin(T * 0.91 * CFG.hairSp + 1.0)) * (1 + 2.2 * st.wind)
        FS.fLx, FS.fRx = st.hlx.x - st.hx.x, st.hrx.x - st.hx.x
        FS.fLy, FS.fRy = st.hly.x - st.hy.x, st.hry.x - st.hy.x
        FS.sLx, FS.sRx = st.slx.x - (st.hx.x * 0.8 + st.bx.x * 0.7), st.srx.x - (st.hx.x * 0.8 + st.bx.x * 0.7)
        FS.sLy, FS.sRy = st.sly.x - (st.hy.x * 0.8 + st.by.x * 0.6), st.sry.x - (st.hy.x * 0.8 + st.by.x * 0.6)
        FS.loX, FS.loY = st.lo2x.x - 1.6 * (st.bx.x + st.hx.x * 0.25), st.lo2y.x - 1.4 * (st.by.x + st.hy.x * 0.2)
        FS.arm = (st.arm.x - st.bx.x) * 0.05 + sin(T * 0.9 + 1) * 0.012 - st.bx.x * 0.010
        FS.hand = (st.hand.x - st.bx.x) * 0.10 + sin(T * 1.15) * 0.026 + sin(T * 2.3 + 1) * 0.009 + FS.hx * 0.02
        FS.gx = clamp(st.gx.x - st.hx.x * 0.45, -1.2, 1.2) * CFG.eyes
        FS.gy = clamp(st.gy.x - st.hy.x * 0.35, -1.2, 1.2) * CFG.eyes
    end

    local function base(x, y, hw, depth, bk)
        local ax, ay = leanAt(x, y)
        local bx, by = breathAt(x, y, bk)
        local hx, hy = headAt(x, y, hw, depth)
        return ax + bx + hx, ay + by + hy
    end

    -- --------------------------------------------------------------- layer rig ---
    local LIDDROP = { lidR = 46, lidL = 42 }
    local FEAT = 1.12

    local RIG = {}
    RIG.pants = function(x, y) return base(x, y, 0, 0, 0) end
    RIG.extra = function(x, y)
        local a, b = base(x, y, 0, 0, 0.4)
        local sx, sy = swayAt(x, y, 800, 180, 0.9, 4.1, FS.loX, FS.loY, 15, 0.55, 17)
        return a + sx, b + sy
    end
    RIG.hairBackL = function(x, y)
        local a, b = base(x, y, 1 - smooth((y - 520) / 220), 0.8, 0.5)
        local sx, sy = swayAt(x, y, 470, 430, 0.5, 0.0, FS.loX, FS.loY, 14, 0.5, 17)
        return a + sx, b + sy
    end
    RIG.shoulderL = function(x, y)
        local a, b = base(x, y, 0, 0, 1)
        local ra, rb = rotAbout(x, y, 250, 600, FS.arm * 0.6, 1)
        return a + ra, b + rb
    end
    RIG.armL = function(x, y)
        local a, b = base(x, y, 0, 0, 1)
        local ra, rb = rotAbout(x, y, 250, 600, FS.arm, 1)
        local hw = smooth((760 - y) / 190) * (x < 160 and 1 or 0)
        local ha, hb = rotAbout(x, y, 62, 735, FS.hand, hw)
        return a + ra + ha, b + rb + hb
    end
    RIG.armR = function(x, y)
        local a, b = base(x, y, 0, 0, 1)
        local ra, rb = rotAbout(x, y, 820, 590, -FS.arm * 0.7, 1)
        return a + ra, b + rb
    end
    RIG.body = function(x, y) return base(x, y, 0, 0, 1) end
    RIG.hairChestL = function(x, y)
        local a, b = base(x, y, 1 - smooth((y - 520) / 220), 0.9, 1)
        local sx, sy = swayAt(x, y, 440, 230, 1.0, 1.7, FS.sLx, FS.sLy, 16, 1.3, 11)
        return a + sx, b + sy
    end
    RIG.hairChestR = function(x, y)
        local a, b = base(x, y, 1 - smooth((y - 520) / 240), 0.9, 1)
        local sx, sy = swayAt(x, y, 380, 270, 1.0, 2.6, FS.sRx, FS.sRy, 17, 1.2, 11)
        return a + sx, b + sy
    end
    RIG.hairBackR = function(x, y)
        local a, b = base(x, y, 1 - 0.7 * smooth((y - 470) / 160), 0.75, 0.5)
        local sx, sy = swayAt(x, y, 90, 380, 1.0, 3.3, FS.sRx, FS.sRy, 20, 0.8, 14)
        return a + sx, b + sy
    end
    RIG.hairFill = function(x, y) return base(x, y, 1, 0.9, 0) end
    RIG.bkL = function(x, y) return base(x, y, 1 - smooth((y - 520) / 220), 0.8, 0.5) end
    RIG.bkR = function(x, y) return base(x, y, 1 - 0.7 * smooth((y - 470) / 160), 0.75, 0.5) end
    RIG.bkX = function(x, y) return base(x, y, 0, 0, 0.4) end
    RIG.face = function(x, y) return base(x, y, 1, 1.0, 0) end
    local function feature(x, y) return base(x, y, 1, FEAT, 0) end
    RIG.scleraR, RIG.scleraL = feature, feature
    local function irisFn(x, y, cx, cy)
        local gx, gy = FS.gx, FS.gy
        local sxs = 1 - 0.07 * abs(gx)
        local a, b = feature(x, y)
        return a + (cx + (x - cx) * sxs - x) + gx * 6.8, b + gy * (gy < 0 and 3.8 or 2.4)
    end
    RIG.irisL = function(x, y) return irisFn(x, y, 410, 408) end
    RIG.irisR = function(x, y) return irisFn(x, y, 570, 378) end
    local function lidNode(name, lid, x, y)
        local a, b = feature(x, y)
        local t = D.layers[name].y
        local ny = t + (y - t) * (1 - 0.22 * lid) + LIDDROP[name] * lid
        return a, b + (ny - y)
    end
    RIG.lidR = function(x, y) return lidNode('lidR', st.lidR, x, y) end
    RIG.lidL = function(x, y) return lidNode('lidL', st.lidL, x, y) end
    local function browNode(lid, x, y) local a, b = feature(x, y); return a, b + lid * 2.0 end
    RIG.browR = function(x, y) return browNode(st.lidR, x, y) end
    RIG.browL = function(x, y) return browNode(st.lidL, x, y) end
    RIG.hairFront = function(x, y)
        local a, b = base(x, y, 1, 1.25, 0)
        local k = 0.45 + 0.55 * clamp(abs(x - 440) / 160, 0, 1)
        local lx, ly
        if x < 440 then lx, ly = FS.fLx, FS.fLy else lx, ly = FS.fRx, FS.fRy end
        local sx, sy = swayAt(x, y, 130, 360, k, 5.0, lx, ly, 17, 1.0, 11)
        return a + sx, b + sy
    end

    -- ------------------------------------------------------------------ drawing --
    local OX, OY, AX, AY, SC = 0, 0, 0, 0, 1
    local MASTER = 4294967295
    local FACE_X, FACE_Y = 480, 400

    -- Статика слоя считается один раз: узлы сетки в дизайн-координатах, UV, список «живых» ячеек и нужных вершин.
    local function buildLayer(name)
        local Ly = D.layers[name]
        local nx, ny = Ly.nx, Ly.ny
        local row = nx + 1
        local c = { row = row, n = row * (ny + 1), sx = {}, sy = {}, gx = {}, gy = {}, pu = {}, quads = {}, vi = {}, fn = RIG[name] }
        local k = 0
        for b = 0, ny do
            local v = b / ny
            local my = Ly.y + v * Ly.h
            for a = 0, nx do
                local u = a / nx
                k = k + 1
                c.sx[k], c.sy[k] = Ly.x + u * Ly.w, my
                c.pu[k] = imgui.ImVec2((Ly.ax + u * Ly.aw) / D.AW, (Ly.ay + v * Ly.ah) / D.AH)
            end
        end
        local alive, used, q = Ly.alive, {}, 0
        for b = 0, ny - 1 do
            for a = 0, nx - 1 do
                if alive:byte(b * nx + a + 1) == 49 then
                    local p1 = b * row + a + 1
                    q = q + 1; c.quads[q] = p1
                    used[p1], used[p1 + 1], used[p1 + row], used[p1 + row + 1] = true, true, true, true
                end
            end
        end
        local m = 0
        for i = 1, c.n do if used[i] then m = m + 1; c.vi[m] = i end end   -- вершины, реально участвующие в рисовании
        c.nq, c.nv = q, m
        return c
    end

    -- Тяжёлая часть (риг-функции на каждую вершину): вызывается не чаще CFG.fps раз в секунду.
    local function generate()
        for _, name in ipairs(D.order) do
            local c = C[name]
            if c and c.fn then
                local fn, sx, sy, gx, gy, vi = c.fn, c.sx, c.sy, c.gx, c.gy, c.vi
                for j = 1, c.nv do
                    local k = vi[j]
                    local dx, dy = fn(sx[k], sy[k])
                    gx[k], gy[k] = sx[k] + dx, sy[k] + dy
                end
            end
        end
    end

    -- Лёгкая часть, каждый кадр: перевод кэша в экранные px (окно могло сдвинуться/смениться масштаб) и вывод квадов.
    local function emitLayer(dl, c)
        local gx, gy, vi, pu, quads, row = c.gx, c.gy, c.vi, c.pu, c.quads, c.row
        for j = 1, c.nv do
            local k = vi[j]
            local p = PP[k]
            p.x, p.y = OX + (gx[k] - AX) * SC, OY + (gy[k] - AY) * SC
        end
        for i = 1, c.nq do
            local p1 = quads[i]
            local p2, p4 = p1 + 1, p1 + row
            local p3 = p4 + 1
            dl:AddImageQuad(texAtlas, PP[p1], PP[p2], PP[p3], PP[p4], pu[p1], pu[p2], pu[p3], pu[p4], MASTER)
        end
    end

    local function screenOf(name, x, y)
        local dx, dy = RIG[name](x, y)
        return OX + (x + dx - AX) * SC, OY + (y + dy - AY) * SC
    end

    -- ---------------------------------------------------------------- public ----
    -- ------------------------------------------------------------- файлы --
    -- Скачивание делает основной скрипт (env.fetch); здесь только список нужных файлов и проверка, что они на месте.
    local FILES = { 'data.lua', 'atlas_s.png' }            -- atlas.png (полный) не нужен: он только запасной вариант
    local function fsize(p) local f = io.open(p, 'rb'); if not f then return 0 end local n = f:seek('end'); f:close(); return n or 0 end
    local function say(t) pcall(sampAddChatMessage, u8:decode('{7fbfff}[Corvus] {ffffff}' .. t), -1) end
    local function filesReady()
        return fsize(DIR .. 'data.lua') > 0 and (fsize(DIR .. 'atlas_s.png') > 0 or fsize(DIR .. 'atlas.png') > 0)
    end

    function M.want() return OPT.asst ~= 'sprite' end        -- выбран ли Live2D в настройках
    local function applyCfg()                              -- настройки из вкладки «Настройки» (читаются каждый кадр, это просто присваивания)
        CFG.track, CFG.blink, CFG.breath, CFG.idle = OPT.l2d_track ~= false, OPT.l2d_blink ~= false, OPT.l2d_breath ~= false, OPT.l2d_idle ~= false
        CFG.fps = OPT.l2d_fps or 40
    end

    function M.ensure()                                   -- один раз: данные слоёв и текстура атласа
        if M.state ~= 'init' or not M.want() then return end
        if not filesReady() then                           -- первый запуск: тянем файлы, пока рисуется прежний спрайт
            M.state = 'dl'
            say('Live2D: скачиваю ассистента (~0.3 МБ)...')
            fetch(FILES, false, function(ok, name, why)
                if ok then M.state = 'init'
                else M.state = 'fail'; M.err = 'download ' .. tostring(name); say('{ff7f7f}Live2D: не удалось скачать ' .. tostring(name) .. ': ' .. tostring(why) .. ' (/l2dupdate - повторить)') end
            end)
            return
        end
        M.state = 'fail'
        local ok, err = pcall(function()
            D = dofile(DIR .. 'data.lua')
            local ap = DIR .. 'atlas_s.png'                   -- уменьшенный атлас (UV нормированы, раскладка та же)
            local fh = io.open(ap, 'rb')
            if fh then fh:close() else ap = DIR .. 'atlas.png' end
            texAtlas = imgui.CreateTextureFromFile(ap)
            assert(texAtlas, 'cannot create atlas texture')
            local n = 0
            for _, Ly in pairs(D.layers) do n = max(n, (Ly.nx + 1) * (Ly.ny + 1)) end
            for k = 1, n do PP[k] = imgui.ImVec2(0, 0) end
            for _, name in ipairs(D.order) do
                if RIG[name] then C[name] = buildLayer(name) end
            end
            M.W, M.H = D.W, D.H
        end)
        if ok then M.state = 'ok'
        else
            M.err = tostring(err)
            say('{ff7f7f}Live2D не загружен (' .. M.err:sub(1, 120) .. '), использую обычный спрайт')
        end
    end

    -- dl: реальный ImDrawList; x0,y0,w,h: прямоугольник в ЭКРАННЫХ px; alpha 0..1; typing: ассистент печатает
    function M.draw(dl, x0, y0, w, h, alpha, typing)
        if M.state ~= 'ok' then return false end
        applyCfg()
        local io = imgui.GetIO()
        local dt = clamp(io.DeltaTime, 0.001, 0.05)
        AX, AY = D.W / 2, D.H / 2
        SC = min(w / D.W, h / D.H)
        OX, OY = x0 + w / 2, y0 + h / 2
        MASTER = rgba(255, 255, 255, 255 * clamp(alpha, 0, 1))
        -- генерация: накопитель времени, шаг 1/fps; пропущенные кадры не «догоняем» (иначе после лага был бы всплеск)
        local step = 1 / max(1, CFG.fps)
        ACC, SINCE = ACC + dt, SINCE + dt
        if ACC >= step or not LAST_OK then
            ACC = ACC - step
            if ACC > step or ACC < 0 then ACC = 0 end
            local sdt = clamp(SINCE, 0.001, 0.05); SINCE = 0
            frameState()
            local fx, fy = screenOf('face', FACE_X, FACE_Y)
            local mp = io.MousePos
            simulate(sdt, mp.x, mp.y, fx, fy, io.DisplaySize.x, io.DisplaySize.y, mp.x > -1000, typing)
            frameState()
            generate()
            LAST_OK = true
        end
        for _, name in ipairs(D.order) do
            local c = C[name]
            if c then emitLayer(dl, c) end
        end
        return true
    end

    return M
end
