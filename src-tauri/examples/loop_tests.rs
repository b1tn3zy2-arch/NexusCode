#[path = "../src/loop_core.rs"]
#[allow(dead_code)]
mod loop_core;

use loop_core::*;

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

    // porcelain parsing
    let porcelain = "\
M  src/main.rs
?? new-file.ts
R  old.txt -> renamed.txt
MM \"quoted path with spaces.rs\"
";
    let files = changed_files_from_porcelain(porcelain);
    check!(
        "porcelain: 4 entries",
        files.len() == 4
            && files.contains(&"src/main.rs".to_string())
            && files.contains(&"new-file.ts".to_string())
            && files.contains(&"renamed.txt".to_string())
            && files.contains(&"quoted path with spaces.rs".to_string())
    );

    check!("porcelain: empty", changed_files_from_porcelain("").is_empty());

    // success pattern
    check!(
        "pattern: simple match",
        success_pattern_matches("ALL TESTS PASSED", "done. ALL TESTS PASSED, bye")
    );
    check!(
        "pattern: regex",
        success_pattern_matches(r"\bbuild (ok|succeeded)\b", "the build succeeded")
    );
    check!(
        "pattern: no match",
        !success_pattern_matches("xyzzy", "nothing here")
    );
    check!("pattern: empty", !success_pattern_matches("   ", "anything"));
    check!(
        "pattern: invalid regex is false",
        !success_pattern_matches("([bad", "anything")
    );

    // config serde round-trip with camelCase (frontend payload shape)
    let json = r#"{
        "sessionId":"ses_1","prompt":"do it","maxIterations":3,"intervalMs":500,
        "autoCommit":true,"runTests":true,"testCommand":"npm test",
        "stopOnTestFailure":false,"noChangesThreshold":1,
        "successPattern":"DONE"
    }"#;
    let cfg: LoopConfig = serde_json::from_str(json).expect("deserialize");
    check!(
        "config camelCase deserialize",
        cfg.session_id == "ses_1"
            && cfg.max_iterations == 3
            && cfg.test_command.as_deref() == Some("npm test")
    );
    let re: LoopConfig = serde_json::from_str(
        &serde_json::to_value(&LoopConfig::default()).unwrap().to_string(),
    )
    .expect("default round-trip");
    check!(
        "config default round-trip",
        re == LoopConfig::default()
    );

    // snapshot serialization uses camelCase too
    let snap = LoopSnapshot { running: true, max_iterations: 9, ..Default::default() };
    let v = serde_json::to_value(&snap).unwrap();
    check!(
        "snapshot camelCase keys",
        v.get("maxIterations").and_then(|x| x.as_u64()) == Some(9)
            && v.get("running").and_then(|x| x.as_bool()) == Some(true)
    );

    if failed > 0 {
        println!("\n{failed} FAILED");
        std::process::exit(1);
    }
    println!("\nall passed");
}
