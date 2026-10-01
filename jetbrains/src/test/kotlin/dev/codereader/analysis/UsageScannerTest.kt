package dev.codereader.analysis

import dev.codereader.model.MethodView
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class UsageScannerTest {
    private val cart = """
        using System;

        namespace Shop
        {
            public class Cart
            {
                private readonly List<Item> items = new();

                public Cart(int capacity)
                {
                    this.capacity = capacity;
                }

                public int CalculateTotal()
                {
                    var total = 0;
                    foreach (var item in items)
                    {
                        total += PriceOf(item);
                    }
                    return ApplyDiscount(total);
                }

                private int PriceOf(Item item) => item.Price * item.Count;

                private int ApplyDiscount(int total)
                {
                    if (total > 100) return total - 10;
                    return total;
                }

                public Task<int> SaveAsync(string path)
                {
                    return Task.FromResult(0);
                }
            }
        }
    """.trimIndent()

    private val checkout = """
        using Shop;

        public class Checkout
        {
            private readonly Cart cart = new Cart(10);

            public void Submit()
            {
                var total = cart.CalculateTotal();
                // cart.CalculateTotal() is cheap
                button.Click += OnClick;
            }

            private void OnClick(object sender, EventArgs e)
            {
                await cart.SaveAsync("cart.json");
            }
        }

        interface ICart { int CalculateTotal(); }
    """.trimIndent()

    private val csharp = CodeHeuristics("cs")

    private fun declares(line: String, name: String) = csharp.isDeclaration(line, name, line.indexOf(name))

    @Test
    fun `recognises C# declarations`() {
        assertTrue(declares("        public int CalculateTotal()", "CalculateTotal"))
        assertTrue(declares("        private int PriceOf(Item item) => item.Price * item.Count;", "PriceOf"))
        assertTrue(declares("        public Task<int> SaveAsync(string path)", "SaveAsync"))
        assertTrue(declares("        public Cart(int capacity)", "Cart"))
        assertTrue(declares("interface ICart { int CalculateTotal(); }", "CalculateTotal"))
    }

    @Test
    fun `recognises C# calls`() {
        assertFalse(declares("                total += PriceOf(item);", "PriceOf"))
        assertFalse(declares("            return ApplyDiscount(total);", "ApplyDiscount"))
        assertFalse(declares("        var total = cart.CalculateTotal();", "CalculateTotal"))
        assertFalse(declares("        if (ready) Submit();", "Submit"))
        assertFalse(declares("        await SaveAsync(path);", "SaveAsync"))
        assertFalse(declares("        Submit();", "Submit"))
        assertFalse(declares("        var ok = a > Limit(b);", "Limit"))
    }

    @Test
    fun `keyword languages only declare after their keyword`() {
        val python = CodeHeuristics("py")
        assertTrue(python.isDeclaration("def price_of(item):", "price_of", 4))
        assertFalse(python.isDeclaration("    return sum(price_of(i) for i in items)", "price_of", 15))
        val kotlin = CodeHeuristics("kt")
        assertTrue(kotlin.isDeclaration("    suspend fun load(path: String): Text {", "load", 16))
        assertFalse(kotlin.isDeclaration("    scope.launch(Dispatchers.IO) {", "launch", 10))
        assertFalse(kotlin.isDeclaration("    repeat(3) {", "repeat", 4))
    }

    @Test
    fun `finds the method a line belongs to`() {
        val lines = cart.lines()
        val usage = lines.indexOfFirst { it.contains("total += PriceOf(item);") }
        assertEquals("CalculateTotal", csharp.enclosingMethod(lines, usage))
        val topLevel = lines.indexOfFirst { it.contains("private readonly List<Item> items") }
        assertEquals(null, csharp.enclosingMethod(lines, topLevel))
    }

    @Test
    fun `collects usages across files and skips declarations and comments`() {
        val lines = cart.lines()
        fun method(id: String, name: String) = MethodView(
            id = id,
            name = name,
            container = "Cart",
            line = lines.indexOfFirst { it.contains(name) && csharp.isDeclaration(it, name, it.indexOf(name)) },
            character = 0,
        )
        val methods = listOf(
            method("m1", "Cart"),
            method("m2", "CalculateTotal"),
            method("m3", "PriceOf"),
            method("m4", "SaveAsync"),
        )

        val result = UsageScanner("cs", maxPerMethod = 8).scan(
            current = SourceText("file:///Cart.cs", "Cart.cs") { cart },
            others = listOf(SourceText("file:///Checkout.cs", "Checkout.cs") { checkout }),
            methods = methods,
        )

        val constructor = result.byMethod.getValue("m1")
        assertEquals(listOf("Checkout.cs"), constructor.items.map { it.displayPath })

        val total = result.byMethod.getValue("m2")
        assertEquals(1, total.total)
        assertEquals("Submit", total.items.single().caller)
        assertEquals("var total = cart.CalculateTotal();", total.items.single().preview)

        val price = result.byMethod.getValue("m3")
        assertEquals("CalculateTotal", price.items.single().caller)
        assertEquals("Cart.cs", price.items.single().displayPath)

        val save = result.byMethod.getValue("m4")
        assertEquals("OnClick", save.items.single().caller)

        assertEquals(result.byMethod.values.sumOf { it.items.size }, result.promptItems.size)
        assertEquals(listOf("u1", "u2", "u3", "u4"), result.promptItems.map { it.id })
        assertTrue(result.promptItems.first { it.id == "u2" }.snippet.contains(">> "))
    }

    @Test
    fun `counts a method handed over as a value`() {
        val handler = MethodView(id = "m1", name = "OnClick", container = "Checkout", line = 13, character = 17)
        val result = UsageScanner("cs", maxPerMethod = 8).scan(
            current = SourceText("file:///Checkout.cs", "Checkout.cs") { checkout },
            others = emptyList(),
            methods = listOf(handler),
        )
        assertEquals("button.Click += OnClick;", result.byMethod.getValue("m1").items.single().preview)
    }
}
