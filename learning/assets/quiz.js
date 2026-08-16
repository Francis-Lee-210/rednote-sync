for (const quiz of document.querySelectorAll("[data-quiz]")) {
  const feedback = quiz.querySelector("[data-feedback]");
  for (const button of quiz.querySelectorAll("button[data-choice]")) {
    button.addEventListener("click", () => {
      const row = button.closest("[data-answer]");
      const correct = button.dataset.choice === row.dataset.answer;
      for (const sibling of row.querySelectorAll("button")) {
        sibling.classList.remove("correct", "incorrect");
      }
      button.classList.add(correct ? "correct" : "incorrect");
      feedback.textContent = correct
        ? "正确。你已经能区分这个层次的状态。"
        : "再看一次上面的阶段表：离线可运行，不等于真实账号可同步。";
    });
  }
}
