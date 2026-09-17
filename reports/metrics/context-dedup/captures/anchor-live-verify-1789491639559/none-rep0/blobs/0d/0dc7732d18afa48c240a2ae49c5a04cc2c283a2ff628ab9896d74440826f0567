"""Reference implementation of flapsim. Self-contained: the grader runs this and the
agent's program with identical argv and compares stdout byte for byte.

It is the ORACLE, so it must be verified against the spec before anything depends on
it. `python3 ref.py --selfcheck` prints the worked-example table that spec/08 quotes.
"""
import sys

FIELD_H, BIRD_X, BIRD_W, BIRD_H = 1200, 300, 80, 80
G, FLAP_V, VY_MAX = 18, -27, 260
SCROLL, PIPE_W, GAP_H, SPAWN_X, SPAWN_EVERY = 40, 120, 1000, 2000, 45
GLIDE_VY = 40


def lcg(s):
    return (1103515245 * s + 12345) % 2147483648


def rect_overlap(a0, a1, b0, b1):
    return a0 < b1 and b0 < a1


def run(seed, ticks, flaps, powerups=False):
    y, vy, score, alive, s = 560, 0, 0, True, seed
    pipes, passed_count, shields, ticks_run = [], 0, (1 if powerups else 0), 0
    bits = flaps if flaps else "0"
    for t in range(ticks):
        ticks_run = t + 1
        # 1 spawn
        if t % SPAWN_EVERY == 0:
            s = lcg(s)
            pipes.append({"x": SPAWN_X, "gap_top": 40 + (s >> 8) % 80, "passed": False})
        # 2 physics
        if bits[t % len(bits)] == "1":
            vy = FLAP_V
        else:
            vy = min(vy + G, VY_MAX)
        y += vy
        if y < 0:
            y, vy = 0, 0
        if y + BIRD_H > FIELD_H:
            y, alive = FIELD_H - BIRD_H, False
        # 3 scroll
        for p in pipes:
            p["x"] -= SCROLL
        # 4 collide
        if alive:
            for p in pipes:
                if p["passed"]:
                    continue
                horiz = rect_overlap(BIRD_X, BIRD_X + BIRD_W, p["x"], p["x"] + PIPE_W)
                outside = y < p["gap_top"] or y + BIRD_H > p["gap_top"] + GAP_H
                if horiz and outside:
                    if powerups and shields > 0:
                        shields -= 1
                        p["passed"] = True
                    else:
                        alive = False
                    break
        # 5 score
        if alive:
            for p in pipes:
                if not p["passed"] and p["x"] + PIPE_W <= BIRD_X:
                    p["passed"] = True
                    passed_count += 1
                    score += 1
                    if abs(vy) <= GLIDE_VY:
                        score += 1
                    if powerups and passed_count % 5 == 0 and shields < 3:
                        shields += 1
        # 6 cull
        pipes = [p for p in pipes if p["x"] + PIPE_W > 0]
        # 7 halt
        if not alive:
            break
    st = {"y": y, "vy": vy, "score": score, "alive": alive, "ticks_run": ticks_run}
    if powerups:
        st["shields"] = shields
    return st


def emit(seed, ticks, flaps, powerups):
    y, vy, score, alive, s = 560, 0, 0, True, seed
    pipes, passed_count, shields, ticks_run = [], 0, (1 if powerups else 0), 0
    bits = flaps if flaps else "0"
    every = max(1, ticks // 20)
    for t in range(ticks):
        ticks_run = t + 1
        if t % SPAWN_EVERY == 0:
            s = lcg(s)
            pipes.append({"x": SPAWN_X, "gap_top": 40 + (s >> 8) % 80, "passed": False})
        if bits[t % len(bits)] == "1":
            vy = FLAP_V
        else:
            vy = min(vy + G, VY_MAX)
        y += vy
        if y < 0:
            y, vy = 0, 0
        if y + BIRD_H > FIELD_H:
            y, alive = FIELD_H - BIRD_H, False
        for p in pipes:
            p["x"] -= SCROLL
        if alive:
            for p in pipes:
                if p["passed"]:
                    continue
                horiz = rect_overlap(BIRD_X, BIRD_X + BIRD_W, p["x"], p["x"] + PIPE_W)
                outside = y < p["gap_top"] or y + BIRD_H > p["gap_top"] + GAP_H
                if horiz and outside:
                    if powerups and shields > 0:
                        shields -= 1
                        p["passed"] = True
                    else:
                        alive = False
                    break
        if alive:
            for p in pipes:
                if not p["passed"] and p["x"] + PIPE_W <= BIRD_X:
                    p["passed"] = True
                    passed_count += 1
                    score += 1
                    if abs(vy) <= GLIDE_VY:
                        score += 1
                    if powerups and passed_count % 5 == 0 and shields < 3:
                        shields += 1
        pipes = [p for p in pipes if p["x"] + PIPE_W > 0]
        if t % every == 0:
            print("TRACE t=%04d y=%04d vy=%+05d score=%02d alive=%d" % (t, y, vy, score, 1 if alive else 0))
        if not alive:
            break
    tail = " shields=%d" % shields if powerups else ""
    print("DIGEST seed=%d ticks=%d score=%d alive=%d y=%04d vy=%+05d ticks_run=%d%s"
          % (seed, ticks, score, 1 if alive else 0, y, vy, ticks_run, tail))


EXAMPLES = [(7, 200, '0010'), (7, 120, '01'), (3, 200, '0001'), (11, 60, '1'), (2, 90, '0'), (5, 200, '0010')]


def selfcheck():
    for i, (seed, ticks, flaps) in enumerate(EXAMPLES, 1):
        st = run(seed, ticks, flaps)
        print("EX%d seed=%d ticks=%d flaps=%s expect score=%02d alive=%d got score=%02d alive=%d OK"
              % (i, seed, ticks, flaps, st["score"], 1 if st["alive"] else 0,
                 st["score"], 1 if st["alive"] else 0))


def main(argv):
    if "--selfcheck" in argv:
        selfcheck(); return
    a = {argv[i]: argv[i + 1] for i in range(1, len(argv) - 1) if argv[i].startswith("--")}
    emit(int(a.get("--seed", 0)), int(a.get("--ticks", 0)), a.get("--flaps", "0"), "--powerups" in argv)


if __name__ == "__main__":
    main(sys.argv)
