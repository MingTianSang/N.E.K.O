import json

with open('static/locales/en.json', 'r', encoding='utf-8') as f:
    en = json.load(f)

missing_character = [
    'cannotDeleteCurrentCard', 'cannotHideCurrentCatgirl',
    'cardAuthor', 'cardAuthorPlaceholder', 'cardAuthorReadonly',
    'cardAuthorUpdateFailed', 'cardAuthorUpdated', 'cardCreatedAt',
    'cardMeta', 'cardNotCreated', 'cardOriginImported',
    'cardOriginLabel', 'cardOriginSelf', 'cardOriginSteam',
    'confirmDeleteCard', 'currentCard', 'deleteCard',
    'deleteCardTitle', 'deleteError', 'editAuthor',
    'exportCardOnly', 'hideHidden', 'masterProfileTitle',
    'newCatgirlSuccess', 'renamePrompt', 'renameTitle',
    'saveSuccess', 'settings', 'showHidden',
    'switchCard', 'switchSuccess', 'tempSaveFailed',
]

missing_steam = [
    'addNewCatgirl', 'cardView', 'listView',
    'noCardImage', 'searchCharacterCards',
]

translations_es = {
    'cannotDeleteCurrentCard': 'No se puede eliminar la tarjeta actualmente activa.\n\nCambie a otra tarjeta primero.',
    'cannotHideCurrentCatgirl': 'No se puede ocultar el NEKO actualmente activo',
    'cardAuthor': 'Autor',
    'cardAuthorPlaceholder': 'Sin establecer',
    'cardAuthorReadonly': 'El autor es de solo lectura para esta fuente',
    'cardAuthorUpdateFailed': 'Error al actualizar el autor: {{error}}',
    'cardAuthorUpdated': 'Autor actualizado',
    'cardCreatedAt': 'Creado',
    'cardMeta': 'Información de la tarjeta',
    'cardNotCreated': 'Aún no creado',
    'cardOriginImported': 'Importado',
    'cardOriginLabel': 'Origen',
    'cardOriginSelf': 'Local',
    'cardOriginSteam': 'Steam Workshop',
    'confirmDeleteCard': '¿Eliminar tarjeta "{{name}}"?',
    'currentCard': 'Tarjeta actual',
    'deleteCard': 'Eliminar tarjeta',
    'deleteCardTitle': 'Eliminar tarjeta',
    'deleteError': 'Error al eliminar el NEKO',
    'editAuthor': 'Editar autor',
    'exportCardOnly': 'Exportar esta tarjeta',
    'hideHidden': 'Ocultar ocultos',
    'masterProfileTitle': 'Perfil de maestro',
    'newCatgirlSuccess': 'Nuevo NEKO creado con éxito',
    'renamePrompt': 'Ingrese un nuevo nombre de perfil',
    'renameTitle': 'Cambiar nombre',
    'saveSuccess': 'Guardado con éxito',
    'settings': 'Configuración',
    'showHidden': 'Mostrar ocultos',
    'switchCard': 'Cambiar tarjeta',
    'switchSuccess': 'Cambiado con éxito',
    'tempSaveFailed': 'Error al guardar temporalmente: ',
}

translations_pt = {
    'cannotDeleteCurrentCard': 'Não é possível excluir o cartão atualmente ativo.\n\nMude para outro cartão primeiro.',
    'cannotHideCurrentCatgirl': 'Não é possível ocultar o NEKO atualmente ativo',
    'cardAuthor': 'Autor',
    'cardAuthorPlaceholder': 'Não definido',
    'cardAuthorReadonly': 'O autor é somente leitura para esta fonte',
    'cardAuthorUpdateFailed': 'Falha ao atualizar autor: {{error}}',
    'cardAuthorUpdated': 'Autor atualizado',
    'cardCreatedAt': 'Criado',
    'cardMeta': 'Informações do cartão',
    'cardNotCreated': 'Ainda não criado',
    'cardOriginImported': 'Importado',
    'cardOriginLabel': 'Origem',
    'cardOriginSelf': 'Local',
    'cardOriginSteam': 'Steam Workshop',
    'confirmDeleteCard': 'Excluir cartão "{{name}}"?',
    'currentCard': 'Cartão atual',
    'deleteCard': 'Excluir cartão',
    'deleteCardTitle': 'Excluir cartão',
    'deleteError': 'Erro ao excluir NEKO',
    'editAuthor': 'Editar autor',
    'exportCardOnly': 'Exportar este cartão',
    'hideHidden': 'Ocultar ocultos',
    'masterProfileTitle': 'Perfil do mestre',
    'newCatgirlSuccess': 'Novo NEKO criado com sucesso',
    'renamePrompt': 'Insira um novo nome de perfil',
    'renameTitle': 'Renomear',
    'saveSuccess': 'Salvo com sucesso',
    'settings': 'Configurações',
    'showHidden': 'Mostrar ocultos',
    'switchCard': 'Trocar cartão',
    'switchSuccess': 'Trocado com sucesso',
    'tempSaveFailed': 'Falha ao salvar temporariamente: ',
}

steam_es = {
    'addNewCatgirl': 'Añadir nuevo NEKO',
    'cardView': 'Vista de tarjetas',
    'listView': 'Vista de lista',
    'noCardImage': 'Sin imagen\nde tarjeta',
    'searchCharacterCards': 'Buscar tarjetas de personajes...',
}

steam_pt = {
    'addNewCatgirl': 'Adicionar novo NEKO',
    'cardView': 'Visualização de cartões',
    'listView': 'Visualização em lista',
    'noCardImage': 'Sem imagem\nde cartão',
    'searchCharacterCards': 'Pesquisar cartões de personagens...',
}

for lang, char_map, steam_map in [('es', translations_es, steam_es), ('pt', translations_pt, steam_pt)]:
    path = f'static/locales/{lang}.json'
    with open(path, 'r', encoding='utf-8') as f:
        data = json.load(f)
    for k, v in char_map.items():
        data['character'][k] = v
    for k, v in steam_map.items():
        data['steam'][k] = v
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=4)
        f.write('\n')
    print(f'Fixed {lang}.json')
