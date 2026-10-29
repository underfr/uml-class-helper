# UML Class Helper (StarUML)

Génère le constructeur, les getters et les setters d'une classe dans StarUML (≥ 6), au format PHP.

## Installation

StarUML → **Tools → Extension Manager → Install From URL…** → coller :

```
https://github.com/underfr/uml-class-helper
```

Puis redémarrer StarUML.

## Utilisation

Sélectionner une classe (ou seulement certains attributs), puis clic droit → **UML Helpers**, ou `Cmd/Ctrl+Alt+G`.
**Generate for Whole Diagram** traite toutes les classes du diagramme ouvert.

| Modèle | Généré |
|---|---|
| `-id: ?int` | `+getId(): ?int`, `+setId(id: ?int): void` |
| `-dateDebut: DateTime` | `+__construct(dateDebut: DateTime)`, getter, setter |
| `-actif: bool` | `+isActif(): bool` |
| `-code: string {readOnly}` | getter seulement |
| association vers `Absence` (côté `1` ou `0..1`) | `-absence: ?Absence`, `+getAbsence(): ?Absence`, `+setAbsence(absence: ?Absence): void` |
| association vers `Produit` (côté `0..*`, ex. `0..*` des deux côtés) | `-produit: array<Produit>`, `+getProduit(): array<Produit>`, `+setProduit(produit: array<Produit>): void` |

- `__construct` : attributs non statiques dont le type ne commence pas par `?` (ni multiplicité `0..`/`*`).
- Associations : qui reçoit l'attribut ?
  1. flèche : la classe d'où part la flèche ;
  2. agrégation/composition : la classe côté losange (`Produit ◇── Categorie` → `categorie` dans Produit) ;
  3. association simple : le côté `0..*` reçoit le côté `1` ; sinon les deux.
  
  Rôle vide → nom de la classe.
- Héritage (`Employe ──▷ Personne`) : le `__construct` de l'enfant prend d'abord les paramètres du parent (`__construct(nom, prenom, salaire)`) ; getters/setters seulement pour ses propres attributs.
- Rien n'est dupliqué si on relance ; un seul `Ctrl+Z` annule tout.

## Automatique

- Toute nouvelle classe reçoit `-id: ?int` avec `getId()`/`setId()`.
- Ajouter un attribut crée son getter, son setter et son paramètre dans le `__construct` existant ; le renommer/typer ensuite met tout à jour.
- Changer le type d'un attribut (`-nom: string` → `-nom: int`) met à jour son getter, son setter et son paramètre de `__construct`. Passer en `?string` le retire du constructeur, repasser en `string` l'y remet.
- Renommer un attribut (`-nom` → `-test`) renomme `getNom`/`setNom`/`isNom` et le paramètre dans le setter et le `__construct`.
- Supprimer un attribut supprime son getter, son setter et son paramètre du `__construct` (2 `Ctrl+Z` pour tout récupérer).
- Supprimer une association supprime l'attribut qu'elle avait généré (`-categorie: ?Categorie`) et ses méthodes, y compris quand on supprime la classe à l'autre bout.
- Renommer une classe met à jour les types texte `?Ancien` → `?Nouveau` partout.
- Tracer un héritage retire le `-id` de l'enfant (le parent l'a déjà) et ajoute les paramètres du parent dans son `__construct` s'il existe.
- Ajouter, renommer, retyper ou supprimer un attribut du parent met aussi à jour le `__construct` des classes filles.
