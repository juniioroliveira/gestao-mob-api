// Regra do ciclo salário/adiantamento (confirmada com o usuário):
// - Salário (dia X) cobre contas com vencimento de X até (dia do adiantamento − 1)
// - Adiantamento (dia Y) cobre contas com vencimento de Y até (dia do salário − 1)
// Os dois períodos juntos fecham o mês inteiro, sem sobra nem buraco — por isso
// os dois `if` abaixo são espelhados (qual dia vem primeiro no mês decide qual
// dos dois "engole" o resto do mês até o próximo, e vice-versa).
//
// Extraído pra cá porque tanto o badge da Home (`homeController`) quanto o
// Termômetro Financeiro (`walletController`) precisam da MESMA regra — tínhamos
// os dois ligeiramente divergentes antes (só a Home usava isso de verdade; o
// Termômetro tinha uma lógica de ciclo paralela e nem chegava a decidir o
// vermelho/verde com ela).
function getPeriodForDueDay(dueDay, salaryDay, advanceDay) {
    if (!salaryDay || !advanceDay) return 'SALARY'; // sem os dois dias configurados, não dá pra separar
    if (salaryDay < advanceDay) {
        return (dueDay >= salaryDay && dueDay < advanceDay) ? 'SALARY' : 'ADVANCE';
    }
    return (dueDay >= advanceDay && dueDay < salaryDay) ? 'ADVANCE' : 'SALARY';
}

module.exports = { getPeriodForDueDay };
