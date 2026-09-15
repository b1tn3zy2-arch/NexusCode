#[path = "../src/continuous_core.rs"]
#[allow(dead_code)]
mod continuous_core;

use continuous_core::*;

fn main() {
    let mut failed = 0;

    macro_rules! check {
        ($name:expr, $cond:expr) => {
            if $cond {
                println!("PASS {}", $name);
            } else {
                println!("FAIL {}", $name);
                failed += 1;
            }
        };
    }

    let plan_text = "\
Here is my plan:

1. Create the config module
2. **Implement** the parser.
3) Write unit tests for the parser
4. Update README with usage examples

Let's begin!
";
    let steps = parse_plan(plan_text);
    check!("plan: 4 items", steps.len() == 4);
    check!(
        "plan: markdown stripped",
        steps.get(1).map(|s| s.as_str()) == Some("Implement the parser")
    );
    check!(
        "plan: trailing dot stripped",
        !steps[1].ends_with('.')
    );

    check!("plan: empty text", parse_plan("no plan here").is_empty());

    // dedup + cap
    let dup = parse_plan("1. Do X\n2. Do X\n3. Do Y");
    check!("plan: duplicates removed", dup.len() == 2);

    let subtasks = detect_subtasks(
        "Done. Now I need to update the database schema. Next, I should migrate existing data, and then I will write documentation for it.",
    );
    check!("subtasks: found 2", subtasks.len() == 2);
    check!(
        "subtasks: first content",
        subtasks[0].contains("update the database schema")
    );
    check!(
        "subtasks: second content",
        subtasks[1].contains("migrate existing data")
    );

    check!(
        "subtasks: none in plain reply",
        detect_subtasks("All done, everything works.").is_empty()
    );

    check!(
        "subtasks: russian pattern",
        !detect_subtasks("Готово. Далее нужно покрыть код тестами.").is_empty()
    );

    // config round-trip
    let cfg: ContinuousConfig = serde_json::from_str(
        r#"{"sessionId":"s1","goal":"g","approvalMode":"manual","maxActions":5,
            "maxTimeMinutes":30,"maxCostUsd":2.5,"checkpoints":true,
            "runValidation":false,"validationCommand":null,
            "stopOnValidationError":true,"detectSubtasks":true}"#,
    )
    .unwrap();
    check!("config camelCase", cfg.max_actions == 5 && cfg.max_cost_usd == 2.5);

    let snap = ContinuousSnapshot { running: true, current_index: 2, ..Default::default() };
    let v = serde_json::to_value(&snap).unwrap();
    check!(
        "snapshot camelCase",
        v.get("currentIndex").and_then(|x| x.as_u64()) == Some(2)
    );

    // new-config defaults stay backward compatible with old UI payloads
    check!(
        "config autopilot defaults",
        cfg.until_done && cfg.auto_verify && cfg.max_retries_per_step == 3
    );
    let fresh = ContinuousConfig::default();
    check!(
        "config day-scale budgets",
        fresh.max_actions >= 100 && fresh.max_time_minutes >= 600
    );

    // verify-command detection on fixture dirs
    let probe_base = std::env::temp_dir().join(format!("nc-cont-probe-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&probe_base);
    let mk = |name: &str, files: &[(&str, &str)]| {
        let d = probe_base.join(name);
        std::fs::create_dir_all(&d).unwrap();
        for (f, c) in files {
            std::fs::write(d.join(f), c).unwrap();
        }
        d.to_string_lossy().into_owned()
    };
    let node = mk(
        "node",
        &[(
            "package.json",
            r#"{"scripts":{"build":"tsc","test":"vitest run","lint":"eslint ."}}"#,
        )],
    );
    check!(
        "detect node build+test",
        detect_verify_commands(&node) == vec!["npm run build".to_string(), "npm run test".to_string()]
    );
    let yarn = mk(
        "yarn",
        &[(
            "package.json",
            r#"{"scripts":{"test":"jest"}}"#,
        ), ("yarn.lock", "")],
    );
    check!(
        "detect yarn pm",
        detect_verify_commands(&yarn) == vec!["yarn test".to_string()]
    );
    let cargo = mk("cargo", &[("Cargo.toml", "[package]\nname = \"x\"\n")]);
    check!(
        "detect cargo",
        detect_verify_commands(&cargo) == vec!["cargo test".to_string()]
    );
    let py = mk("py", &[("pyproject.toml", "[tool.pytest]\n")]);
    check!(
        "detect pytest",
        detect_verify_commands(&py) == vec!["pytest -x -q".to_string()]
    );
    let empty = mk("empty", &[]);
    check!("detect empty", detect_verify_commands(&empty).is_empty());
    // everything at once stays capped
    let all = mk(
        "all",
        &[
            ("package.json", r#"{"scripts":{"build":"b","test":"t"}}"#),
            ("Cargo.toml", ""),
            ("go.mod", ""),
            ("pytest.ini", ""),
        ],
    );
    check!("detect capped at 3", detect_verify_commands(&all).len() == 3);
    let _ = std::fs::remove_dir_all(&probe_base);

    if failed > 0 {
        println!("\n{failed} FAILED");
        std::process::exit(1);
    }
    println!("\nall passed");
}
