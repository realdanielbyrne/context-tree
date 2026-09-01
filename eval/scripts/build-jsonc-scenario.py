def main() -> None:
    # Overwrite the scenario file with sw-1-jsonc (this experiment runs that
    # single long task; the probe/dsa/branch rows are not needed here).
    JSONL.write_text(json.dumps(row, ensure_ascii=False) + "\n", encoding="utf-8")

    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = pathlib.Path(tmp)
        cwd_before = os.getcwd()
        os.chdir(tmp_path)
        try:
            write_files(tmp_path, {**row["files"], **row["judge_files"]})
            buggy = run(tmp_path / "hidden_test.py")
            print("=== BUGGY exit=%s ===" % buggy.returncode)
            print((buggy.stdout + buggy.stderr)[-400:])
            (tmp_path / "jsonc_loader.py").write_text(FIXED_LOADER, encoding="utf-8")
            fixed = run(tmp_path / "hidden_test.py")
            print("=== FIXED exit=%s ===" % fixed.returncode)
            print((fixed.stdout + fixed.stderr)[-400:])
        finally:
            os.chdir(cwd_before)

    assert buggy.returncode != 0, "buggy loader should FAIL the hidden test"
    assert fixed.returncode == 0, "correct loader should PASS the hidden test"
    print("OK: sw-1-jsonc written; buggy FAILS / fixed PASSES confirmed")