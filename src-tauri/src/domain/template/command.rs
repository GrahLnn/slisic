use super::input::{
    AssignTaskInput, BulkStatusInput, NewMemberInput, NewTaskInput, TemplateDashboard,
    UnassignTaskInput,
};
use super::service;

#[tauri::command]
#[specta::specta]
pub async fn template_bootstrap() -> std::result::Result<TemplateDashboard, String> {
    service::bootstrap().await.map_err(|err| err.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn template_snapshot() -> std::result::Result<TemplateDashboard, String> {
    service::snapshot().await.map_err(|err| err.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn template_create_member(
    input: NewMemberInput,
) -> std::result::Result<TemplateDashboard, String> {
    service::create_member(input)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn template_create_task(
    input: NewTaskInput,
) -> std::result::Result<TemplateDashboard, String> {
    service::create_task(input)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn template_assign_task(
    input: AssignTaskInput,
) -> std::result::Result<TemplateDashboard, String> {
    service::assign_task(input)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn template_unassign_task(
    input: UnassignTaskInput,
) -> std::result::Result<TemplateDashboard, String> {
    service::unassign_task(input)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn template_bulk_set_status(
    input: BulkStatusInput,
) -> std::result::Result<TemplateDashboard, String> {
    service::bulk_set_status(input)
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn template_reset() -> std::result::Result<TemplateDashboard, String> {
    service::reset().await.map_err(|err| err.to_string())
}
