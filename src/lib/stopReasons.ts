/** Human-readable (Russian) stop/hit reasons for loop & continuous modes. */
const RU: Record<string, string> = {
  // continuous hit reasons
  limit_actions: "достигнут лимит действий",
  limit_time: "достигнут лимит времени",
  limit_cost: "достигнут лимит стоимости",
  step_error: "ошибка шага",
  validation_failed: "валидация провалена",
  // shared finish reasons
  completed: "завершено",
  verified_done: "готово и проверено — build/tests зелёные",
  stopped: "остановлено",
  user: "остановлено пользователем",
  error: "ошибка",
  max_iterations: "достигнут лимит итераций",
  converged: "сошлось — изменений больше нет",
  success_pattern: "сработал success-паттерн",
  test_failure: "провал тестов",
  iteration_timeout: "таймаут ожидания модели (15 мин)",
};

export function stopReasonText(code: string | null | undefined): string {
  if (!code) return "";
  return RU[code] ?? code;
}
