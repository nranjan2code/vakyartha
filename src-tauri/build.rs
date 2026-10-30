fn main() {
    println!("cargo:rustc-env=VAK_TARGET_TRIPLE={}", std::env::var("TARGET").expect("Cargo target"));
    tauri_build::build()
}
